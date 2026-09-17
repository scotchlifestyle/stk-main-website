import { createRecovery, readRecoveryLink } from './recovery.mjs';

// Read credentials once, then remove them before loading any third-party code.
const link = readRecoveryLink(window.location.href);
window.history.replaceState(null, '', window.location.pathname);
const requestForm = document.getElementById('request-form');
const passwordForm = document.getElementById('password-form');
const status = document.getElementById('status');
const heading = document.getElementById('heading');
const intro = document.getElementById('intro');
const signIn = document.getElementById('sign-in');
let previousPhase = '';
function render(state) {
  const isPassword = state.phase === 'ready';
  const success = state.phase === 'success';
  requestForm.hidden = !['request', 'invalid', 'sent'].includes(state.phase);
  passwordForm.hidden = !isPassword;
  for (const input of document.querySelectorAll('input,button')) input.disabled = state.busy;
  heading.textContent = success ? 'Password updated' : isPassword ? 'Choose a new password' : 'Reset your password';
  intro.textContent = success ? 'Your account is ready. Sign in with your new password.' : isPassword ? 'Set a new password for your STK account.' : 'Enter your account email and we’ll send you a reset link.';
  status.textContent = state.message;
  signIn.className = success ? 'primary' : 'secondary';
  if (success) passwordForm.reset();
  if (previousPhase !== state.phase && ['ready', 'success', 'invalid', 'sent'].includes(state.phase)) heading.focus();
  previousPhase = state.phase;
}
try {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.107.0');
  const client = createClient('https://cxzicermzwymgobvvhwk.supabase.co', 'sb_publishable_dReCg6jN107EwowinBcPbw_Nda00ZlS', {
    auth: { persistSession: false, detectSessionInUrl: false, autoRefreshToken: false, flowType: 'implicit', storageKey: 'stk-password-recovery-isolated' }
  });
  const recovery = createRecovery(client.auth, render);
  requestForm.addEventListener('submit', event => { event.preventDefault(); recovery.request(document.getElementById('email').value); });
  passwordForm.addEventListener('submit', event => { event.preventDefault(); recovery.update(document.getElementById('password').value, document.getElementById('confirmation').value); });
  await recovery.start(link);
} catch {
  status.textContent = 'Password reset could not load. Check your connection and reload this page. If you opened an email link, open that link again.';
} finally {
  // Do not retain incoming credentials in the page-level object.
  delete link.access;
  delete link.refresh;
}
