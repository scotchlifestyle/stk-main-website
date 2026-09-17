export const REDIRECT_URL = 'https://stkpoolleague.com/reset-password/';
const INVALID = 'This reset link has expired or cannot be used. Request a new link below.';
export function readRecoveryLink(href, now = Date.now()) {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.slice(1));
  if (url.searchParams.has('code') || ['error', 'error_code', 'error_description'].some(k => hash.has(k) || url.searchParams.has(k))) return { kind: 'invalid' };
  if (!url.hash) return { kind: 'none' };
  const access = hash.get('access_token'), refresh = hash.get('refresh_token');
  const expiry = hash.get('expires_at');
  if (hash.get('type') !== 'recovery' || !access || !refresh || (expiry !== null && (!/^\d+$/.test(expiry) || Number(expiry) * 1000 <= now))) return { kind: 'invalid' };
  return { kind: 'recovery', access, refresh };
}
export function createRecovery(auth, onChange = () => {}) {
  let state = { phase: 'request', busy: false, message: '' };
  let verified = false;
  const publish = (phase, message = '', busy = false) => { state = { phase, message, busy }; onChange(state); };
  async function start(link) {
    if (state.busy) return;
    verified = false;
    if (link.kind !== 'recovery') { publish(link.kind === 'invalid' ? 'invalid' : 'request', link.kind === 'invalid' ? INVALID : ''); return; }
    publish('checking', 'Checking your reset link…', true);
    try {
      const session = await auth.setSession({ access_token: link.access, refresh_token: link.refresh });
      if (session.error || !session.data?.session) throw Error('Invalid');
      const user = await auth.getUser();
      if (user.error || !user.data?.user?.id || user.data.user.id !== session.data.session.user.id) throw Error('Invalid');
      verified = true;
      publish('ready');
    } catch { publish('invalid', INVALID); }
  }
  async function request(email) {
    if (state.busy || verified || state.phase === 'success') return;
    email = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { publish('request', 'Enter your email address.'); return; }
    publish('request', '', true);
    try {
      const result = await auth.resetPasswordForEmail(email, { redirectTo: REDIRECT_URL });
      if (result.error) throw Error('Request failed');
      publish('sent', 'If an account uses that email, a reset link is on its way. Check your inbox and spam folder.');
    } catch { publish('request', 'We could not send the reset link. Please try again in a moment.'); }
  }
  async function update(password, confirmation) {
    if (!verified || state.busy || state.phase !== 'ready') return;
    if (password.length < 8) { publish('ready', 'Use at least 8 characters for your password.'); return; }
    if (password !== confirmation) { publish('ready', 'Your passwords do not match.'); return; }
    publish('ready', '', true);
    try {
      const result = await auth.updateUser({ password });
      if (result.error || !result.data?.user) throw Error('Update failed');
    } catch { publish('ready', 'We could not update your password. Try a stronger password, or request a fresh reset link.'); return; }
    verified = false;
    publish('success', 'Your password has been updated. You can now sign in.');
    try { await auth.signOut({ scope: 'local' }); } catch { /* The password update already succeeded; never report a failed reset. */ }
  }
  return { get state() { return state; }, start, request, update };
}
