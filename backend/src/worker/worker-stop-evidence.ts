import { adminError } from '../admin/admin-errors.js';

// This validates an operator statement, never infers process termination from liveness.
export function validateStopEvidence(
  evidence: string,
  stoppedAt: string,
  now = new Date(),
): Date {
  const date = new Date(stoppedAt);
  if (
    typeof evidence !== 'string' ||
    evidence.length < 20 ||
    evidence.length > 1000 ||
    evidence.trim() !== evidence ||
    Array.from(evidence).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    !Number.isFinite(+date) ||
    date.toISOString() !== stoppedAt ||
    date > now ||
    !/\b(process|pid|machine|computer)\b|العملية|الجهاز/iu.test(evidence) ||
    !/\b(terminated|killed|exited|exit|stopped|shutdown|powered off)\b|إيقاف|توقف|إنهاء|أغلق/iu.test(
      evidence,
    ) ||
    (/\b(heartbeat\w*|offline|unreachable|unresponsive|disconnected|responding)\b|نبض|غير متصل/iu.test(
      evidence,
    ) &&
      !/\b(terminated|killed|exited|powered off|shutdown)\b|إنهاء العملية|إيقاف الجهاز/iu.test(
        evidence,
      )) ||
    /\b(not|never|cannot|can't|unconfirmed|assum\w*|maybe|may|might|unknown|probably)\b|لم يتوقف|غير مؤكد/iu.test(
      evidence,
    )
  )
    throw adminError('RECOVERY_PROOF_REQUIRED');
  return date;
}
