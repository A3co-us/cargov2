import { Router } from 'express';
import { authRequired } from '../auth.js';
import { getServerErrors } from '../logsBuffer.js';

// Recent server-side API errors for the client diagnostics report. Any
// signed-in role may read them (viewers too — they also hit errors).
const router = Router();

router.get('/logs', authRequired, (_req, res) => {
  res.json({ entries: getServerErrors() });
});

export default router;
