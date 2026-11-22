// No auth tokens in localStorage/sessionStorage, URLs retained in history, or logs.
const $ = id => document.getElementById(id);
const status = message => { $('status').textContent = message; };
let token, config, authorizationID;
const callback = 'https://claude.ai/api/mcp/auth_callback';
async function auth(path, method = 'GET', body) {
  const response = await fetch(`${config.projectURL}/auth/v1${path}`, {
    method, credentials: 'omit', cache: 'no-store', headers: {
      apikey: config.publishableKey, 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Error('Authentication request failed. Check your credentials or start again from Claude.');
  return response.status === 204 ? {} : response.json();
}
function redirect(url) {
  const target = new URL(url);
  if (`${target.origin}${target.pathname}` !== callback || target.username || target.password) throw Error('Unexpected return address. Start again from Claude.');
  token = undefined; sessionStorage.removeItem('streamline-authorization-id');
  window.location.assign(target.href);
}
async function showConsent() {
  await auth('/user');
  const details = await auth(`/oauth/authorizations/${encodeURIComponent(authorizationID)}`);
  if (details.redirect_url) { redirect(details.redirect_url); return; }
  if (details.client?.id !== config.clientID || details.redirect_uri !== callback) throw Error('This connection request is not for the approved Claude client.');
  $('login').hidden = true; $('consent').hidden = false; $('password').value = '';
  status('Signed in. Review the access below before connecting.');
}
async function busy(action) {
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  try { await action(); } catch (error) { status(error.message); }
  finally { document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
$('login').addEventListener('submit', event => { event.preventDefault(); void busy(async () => {
  status('Signing in…');
  const session = await auth('/token?grant_type=password', 'POST', { email: $('email').value.trim(), password: $('password').value });
  token = session.access_token; $('password').value = ''; await showConsent();
}); });
$('magic').addEventListener('click', () => void busy(async () => {
  if (!$('email').reportValidity()) return;
  const returnURL = new URL('consent.html', window.location.href); returnURL.searchParams.set('authorization_id', authorizationID);
  sessionStorage.setItem('streamline-authorization-id', authorizationID);
  await auth(`/otp?redirect_to=${encodeURIComponent(returnURL.href)}`, 'POST', { email: $('email').value.trim(), create_user: false });
  status('Open the sign-in link in your email, then review the connection. If this request expires, start again from Claude.');
}));
for (const action of ['approve','deny']) $(action).addEventListener('click', () => void busy(async () => {
  const result = await auth(`/oauth/authorizations/${encodeURIComponent(authorizationID)}/consent`, 'POST', { action });
  redirect(result.redirect_url);
}));
await busy(async () => {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  history.replaceState(null, '', window.location.pathname + window.location.search);
  const response = await fetch('consent-config.json', { cache: 'no-store' });
  if (!response.ok) throw Error('Connection page is not configured yet.');
  config = await response.json();
  authorizationID = new URLSearchParams(window.location.search).get('authorization_id') || sessionStorage.getItem('streamline-authorization-id');
  if (!authorizationID || !/^[a-zA-Z0-9_-]{1,200}$/.test(authorizationID)) throw Error('Start by adding the Streamline connector in Claude, then follow its sign-in link.');
  token = fragment.get('access_token') || undefined;
  if (token) await showConsent();
  else { $('login').hidden = false; status('Sign in to your existing Streamline account to continue.'); }
});
