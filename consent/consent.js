// Access/refresh tokens are never persisted or logged. The expiring PKCE proof
// is stored separately so an email link can open in another tab of this browser.
if (window.top !== window.self) throw new Error('Open the Streamline consent page in its own tab.');
const $ = id => document.getElementById(id);
const status = message => { $('status').textContent = message; };
const callback = 'https://claude.ai/api/mcp/auth_callback';
const flowKey = 'streamline-signin-pkce';
let token, config, authorizationID, ready = false;
const parameters = new URLSearchParams(window.location.search);
const hadFragment = Boolean(window.location.hash);
const code = parameters.get('code');
parameters.delete('code');
// Remove codes and fragments before loading any other resource.
history.replaceState(null, '', window.location.pathname + (parameters.size ? '?' + parameters : ''));
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
  token = undefined; localStorage.removeItem(flowKey);
  window.location.assign(target.href);
}
async function showConsent() {
  if (typeof token !== 'string' || !token) throw Error('Sign-in did not return a valid session. Start again from Claude.');
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
  finally { document.querySelectorAll('button').forEach(b => b.disabled = !ready); }
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function pendingFlow() {
  let flow;
  try { flow = JSON.parse(localStorage.getItem(flowKey)); } catch { /* Invalid state is discarded. */ }
  if (!flow || typeof flow.expires !== 'number' || flow.expires <= Date.now() ||
      flow.expires > Date.now() + 600000 || !/^[A-Za-z0-9_-]{43}$/.test(flow.verifier)) {
    localStorage.removeItem(flowKey); return undefined;
  }
  return flow;
}
$('login').addEventListener('submit', event => { event.preventDefault(); return busy(async () => {
  if (!ready) return;
  status('Signing in…');
  let session;
  try { session = await auth('/token?grant_type=password', 'POST', { email: $('email').value.trim(), password: $('password').value }); }
  finally { $('password').value = ''; }
  localStorage.removeItem(flowKey);
  token = session.access_token; await showConsent();
}); });
$('magic').addEventListener('click', () => busy(async () => {
  if (!ready || !$('email').reportValidity()) return;
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const returnURL = new URL('/consent.html', config.consentOrigin);
  returnURL.searchParams.set('authorization_id', authorizationID);
  localStorage.setItem(flowKey, JSON.stringify({ verifier, authorizationID, expires: Date.now() + 600000 }));
  try {
    await auth(`/otp?redirect_to=${encodeURIComponent(returnURL.href)}`, 'POST', {
      email: $('email').value.trim(), create_user: false,
      code_challenge: challenge, code_challenge_method: 's256',
    });
  } catch (error) { localStorage.removeItem(flowKey); throw error; }
  status('Open the email link in this same browser within 10 minutes, then review the connection. If it expires, start again from Claude.');
}));
for (const action of ['approve','deny']) $(action).addEventListener('click', () => busy(async () => {
  if (!ready || !token || $('consent').hidden) return;
  const result = await auth(`/oauth/authorizations/${encodeURIComponent(authorizationID)}/consent`, 'POST', { action });
  redirect(result.redirect_url);
}));
await busy(async () => {
  const response = await fetch('consent-config.json', { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw Error('Connection page is not configured yet.');
  config = await response.json();
  if (window.location.origin !== config.consentOrigin || !config.consentOrigin.startsWith('https://')) throw Error('Open the production sign-in page from Claude. Preview copies cannot sign in.');
  authorizationID = parameters.get('authorization_id');
  if (!authorizationID || !/^[a-zA-Z0-9_-]{1,200}$/.test(authorizationID)) throw Error('Start by adding the Streamline connector in Claude, then follow its sign-in link.');
  if (hadFragment) throw Error('This sign-in link uses an unsupported login flow. Start again from Claude.');
  const flow = pendingFlow();
  if (code) {
    if (!flow || flow.authorizationID !== authorizationID) throw Error('Open this link in the browser where you requested it, or start again from Claude.');
    localStorage.removeItem(flowKey);
    const session = await auth('/token?grant_type=pkce', 'POST', { auth_code: code, code_verifier: flow.verifier });
    token = session.access_token;
    await showConsent();
  } else { $('login').hidden = false; status('Sign in to your existing Streamline account to continue.'); }
  ready = true;
});
