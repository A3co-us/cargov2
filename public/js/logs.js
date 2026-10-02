// Diagnostics log: captures placement rejections (with the exact geometry
// numbers that explain WHY a pose was rejected), console/runtime errors and
// failed API calls in an in-memory ring buffer, merges recent server-side
// errors, and renders everything as a copyable text report — so a user can
// paste the log to get a diagnosis instead of a bare "illegal placement".
import { el, openModal, toast } from './ui.js';
import { state, activeScenario } from './store.js';
import { DEFAULT_MAX_OVERHANG_PCT } from './cargo.js';

const MAX_EVENTS = 300;
const TOKEN_KEY = 'a3_token'; // keep in sync with api.js
const events = [];

function record(kind, title, lines = []) {
  // Deduplicate identical bursts (e.g. one error per animation frame).
  const last = events[events.length - 1];
  if (last && last.kind === kind && last.title === title && Date.now() - last.t < 1000) return;
  events.push({ t: Date.now(), kind, title: String(title), lines: lines.map(String) });
  if (events.length > MAX_EVENTS) events.shift();
}

export function logError(message, lines = []) {
  record('error', message, lines);
}

export function logInfo(title, lines = []) {
  record('info', title, lines);
}

/**
 * Record a structured placement rejection produced by cargo.js
 * explainPlacementError(). `phase` describes the user action ("drag",
 * "edit", "remove", ...) for context in the report.
 */
export function logPlacementReject(explanation, phase = '') {
  if (!explanation) return;
  const d = explanation.detail || {};
  const lines = [`rule: ${explanation.rule}`];
  if (d.pose && d.dims) {
    lines.push(`pose: x ${d.pose.x} y ${d.pose.y} z ${d.pose.z} · dims ${d.dims.l}×${d.dims.w}×${d.dims.h} ft`);
  }
  if (explanation.rule === 'unsupported') {
    lines.push(`item bottom y ${d.itemBottom} · legal supports: ${d.legalSupports?.length ? d.legalSupports.join(', ') : 'NONE'}`);
    lines.push(`overhang: ${d.overhangPct}% of footprint uncovered vs allowance ${d.allowancePct}%`);
    lines.push(d.restYLegal != null
      ? `lowest legal resting height at this footprint: ${d.restYLegal} ft`
      : 'no legal resting height exists at this XZ footprint (fragile base, hazmat mismatch, overhang or too tall)');
    if (d.bases?.length) {
      lines.push('items under the footprint:');
      for (const b of d.bases) {
        lines.push(`  "${b.name}" top ${b.top} ft, footprint overlap ${b.overlapPct}% → ${b.verdict}`);
      }
    } else {
      lines.push('nothing overlaps the footprint on the floor plane — item floats in open air');
    }
  }
  if (d.with) {
    lines.push(`collides with "${d.with.name}" @ x ${d.with.x} y ${d.with.y} z ${d.with.z}, ${d.with.dims.l}×${d.with.dims.w}×${d.with.dims.h} ft`);
  }
  if (d.partner) {
    lines.push(`hazmat conflict with "${d.partner.name}" (class ${d.partner.hazmatClass} vs own class ${d.own?.hazmatClass})`);
  }
  if (d.totalWeight != null) {
    lines.push(`total weight ${d.totalWeight} lb vs container payload limit ${d.payloadLb} lb`);
  }
  if (d.note) lines.push(d.note);
  record('placement', `Placement rejected — ${explanation.message}${phase ? ` (${phase})` : ''}`, lines);
}

function fmtValue(v) {
  if (v instanceof Error) return v.stack ? `${v.message}\n${v.stack}` : v.message;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Install the always-on capture: window errors, unhandled promise
 * rejections and console.error/warn (still forwarded to the real console).
 */
export function initDiagnostics() {
  window.addEventListener('error', (e) => {
    logError(e.message, e.error ? [fmtValue(e.error)] : [`at ${e.filename}:${e.lineno}:${e.colno}`]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    logError(`Unhandled promise rejection: ${reason?.message || reason}`,
      [reason?.stack].filter(Boolean).map(String));
  });
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      record(level === 'error' ? 'error' : 'warn', args.map(fmtValue).join(' '));
      orig(...args);
    };
  }
}

function formatEvent(e) {
  const ts = new Date(e.t).toISOString().slice(11, 23);
  const head = `[${ts}] ${e.kind.toUpperCase()} ${e.title}`;
  return e.lines.length ? `${head}\n    ${e.lines.join('\n    ')}` : head;
}

/**
 * Build the full copyable diagnostics report (header + client events +
 * best-effort recent server errors). Async because server logs are fetched.
 */
export async function getLogsReport() {
  const scn = activeScenario();
  const lines = [
    '=== A3 Shipping Pro diagnostics ===',
    `time: ${new Date().toISOString()}`,
    `url: ${location.href}`,
    `user: ${state.user ? `${state.user.username} (${state.user.role})` : 'not signed in'}`,
  ];
  if (state.project) {
    lines.push(`project: "${state.project.name}"${state.project.id != null ? ` (id ${state.project.id})` : ' (unsaved)'}`);
  }
  if (scn) {
    lines.push(`scenario: "${scn.name}" (${scn.containerType}) · ` +
      `overhang allowance ${scn.maxOverhangPct ?? DEFAULT_MAX_OVERHANG_PCT}% · ` +
      `snap-to-grid ${state.snapToGridEnabled ? 'ON (1")' : 'OFF'}`);
  }
  lines.push('', `--- client events (${events.length}) ---`);
  if (!events.length) lines.push('(no events recorded this session)');
  for (const e of events) lines.push(formatEvent(e));
  try {
    const token = state.token || localStorage.getItem(TOKEN_KEY);
    const res = await fetch('/api/logs', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (res.ok) {
      const { entries = [] } = await res.json();
      lines.push('', `--- recent server errors (${entries.length}) ---`);
      if (!entries.length) lines.push('(none)');
      for (const s of entries) {
        lines.push(`[${s.time}] ${s.method} ${s.path} -> ${s.status} ${s.message}` +
          (s.stack ? `\n    ${s.stack}` : ''));
      }
    }
  } catch {
    // Offline or signed out: the client events above still get reported.
  }
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts / older browsers.
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** The Logs modal: filterable event list + Copy / Download / Clear. */
export function logsModal() {
  openModal((close) => {
    const list = el('div', { class: 'log-list' });
    const select = el('select', { class: 'log-filter' });

    const render = () => {
      const filter = select.value;
      const filtered = events.filter((e) =>
        filter === 'all' ||
        (filter === 'placement' && e.kind === 'placement') ||
        (filter === 'error' && e.kind !== 'placement' && e.kind !== 'info'));
      list.replaceChildren();
      if (!filtered.length) {
        list.appendChild(el('div', { class: 'log-empty', text: 'No events yet.' }));
        return;
      }
      for (const e of [...filtered].reverse()) {
        list.appendChild(el('div', { class: `log-entry log-${e.kind}` }, [
          el('div', { class: 'log-title', text: formatEvent(e) }),
        ]));
      }
    };

    for (const [value, label] of [
      ['all', `All events (${events.length})`],
      ['placement', 'Placement rejections'],
      ['error', 'Errors & warnings'],
    ]) {
      select.appendChild(el('option', { value, text: label }));
    }
    select.addEventListener('change', render);
    render();

    const btnCopy = el('button', {
      class: 'btn primary', text: 'Copy for support',
      onClick: async () => {
        const ok = await copyText(await getLogsReport());
        toast(ok ? 'Diagnostics copied to clipboard' : 'Copy failed — use Download instead', ok ? 'ok' : 'error');
      },
    });
    const btnDownload = el('button', {
      class: 'btn', text: 'Download .txt',
      onClick: () => {
        getLogsReport().then((text) => {
          const a = el('a', {
            href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })),
            download: `a3-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
          });
          a.click();
          URL.revokeObjectURL(a.href);
        });
      },
    });
    const btnClear = el('button', {
      class: 'btn danger', text: 'Clear',
      onClick: () => { events.length = 0; render(); toast('Log cleared', 'ok'); },
    });

    return el('div', { class: 'log-modal' }, [
      el('p', {
        class: 'muted small',
        text: 'Kept in memory for this session only. "Copy for support" copies the full report (app state, placement-rejection geometry, console errors, failed API calls, recent server errors) as text you can paste for diagnosis.',
      }),
      el('div', { class: 'log-toolbar' }, [select, btnCopy, btnDownload, btnClear]),
      list,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', text: 'Close', onClick: close }),
      ]),
    ]);
  }, { title: 'Diagnostics Log' });
}
