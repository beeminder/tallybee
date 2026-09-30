/*******************************************************************************
 * Thanks especially to Christopher Moravec for the inspiration here.
 ******************************************************************************/

const API = 'https://www.beeminder.com/api/v1/';

// How long, in milliseconds, to wait for Beeminder to answer an API call before
// giving up on it, as if the answer got lost, so that a call that never gets
// one (like over a dead connection) can't leave TallyBee waiting forever
const PATIENCE = 30000;

// What to tell the user when Beeminder rejects the access token we saved, as
// happens if they log in to TallyBee on another device.
const REAUTH = "Are you logged in on another device? Try logging in again here.";

// What to tell the user when the page's URL is a login redirect from Beeminder
// (like with an access token in it) that this tab didn't ask for, as from a
// link someone crafted to log you in as them.
const UNASKED = "Shenanigans afoot. Tell us you got ERROR_1526 if you see this.";

// Throw an error with message msg unless cond is true
function assert(cond, msg) { if (!cond) throw new Error(msg) }

// The {token, user} object that autoLogin saved, or null if we're logged out
function getTokenObj() {
  return JSON.parse(localStorage.getItem('beeminder-token'));
}

// Who we're logged in as, or undefined if we're logged out
function getUsername() { return getTokenObj()?.user }

function getToken() {
  const tokenObj = getTokenObj();
  assert(tokenObj !== null, REAUTH);
  return tokenObj.token;
}

// Parse Beeminder's JSON response to an API call made with access token token,
// or throw an error saying what went wrong. A 401 means Beeminder rejected the
// token, so we forget it.
async function check(response, token) {
  if (response.status === 401) { logout(token); throw new Error(REAUTH) }
  if (!response.ok)
    throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

// Forget access token token, if it's the one we have: a login since the call
// that got it rejected (like in another tab) may have gotten us a new one
function logout(token) {
  if (getTokenObj()?.token === token) localStorage.removeItem('beeminder-token');
}

// This tab's OAuth state (RFC 6749 section 10.12): a random string that login
// sends to Beeminder and Beeminder sends back with the access token, so a
// redirect with some other state (or none, like in a link someone made up) can
// be ignored. It's the same for the life of the tab.
function tabState() {
  sessionStorage.setItem('beeminder-state',
    sessionStorage.getItem('beeminder-state') ?? crypto.randomUUID());
  return sessionStorage.getItem('beeminder-state');
}

// Send the user off to Beeminder to log in and authorize TallyBee, which then
// sends them back to redirectUrl (see autoLogin)
function login(clientId, redirectUrl) {
  assert(clientId, "clientId must be specified");
  // build url
  const loginUrl = 'https://www.beeminder.com/apps/authorize?' +
    new URLSearchParams({ client_id: clientId, redirect_uri: redirectUrl,
                          response_type: 'token', state: tabState() });
  // send user to the login page
  window.location.href = loginUrl;
}

// If this page load is Beeminder redirecting back to us after login, deal with
// what it sent: an error, which this throws, or an access token, which this
// saves. With the token, it returns true and loads the page again at cleanUrl,
// without the token in it, so nothing, like an app installed from the page,
// can pick the token up from the URL the page was loaded from. A redirect only
// counts if it has this tab's state (see tabState), so a link with someone
// else's access token in it can't quietly log you in as them.
function autoLogin(cleanUrl) {
  // check for URL parameters that mean we have an error logging in or we just got a redirect
  const urlParams = new URLSearchParams(window.location.search);
  if (!urlParams.has('access_token') && !urlParams.has('error')) return false;

  // remove access_token from url
  window.history.replaceState({}, document.title, cleanUrl);
  assert(urlParams.get('state') === tabState(), UNASKED);

  // example url that means the user denied the app access
  // https://beeminderjsapisample.morehavoc.repl.co/?error=access_denied&error_description=The+user+denied+you+access
  assert(!urlParams.has('error'),
         `${urlParams.get('error')}: ${urlParams.get('error_description')}`);

  // example url that means the user granted app access
  // https://beeminderjsapisample.morehavoc.repl.co/?access_token=ABC123&username=morehavoc
  assert(urlParams.get('username'),
         JSON.stringify({ username: urlParams.get('username') }));
  const tokenObj = {
    token: urlParams.get('access_token'),
    user:  urlParams.get('username'),
  };
  localStorage.setItem('beeminder-token',JSON.stringify(tokenObj));
  window.location.replace(cleanUrl);
  return true;
}

// The user's goals, most urgent first, as a list of Beeminder goal objects.
// ("me" in these URLs is Beeminder's stand-in for the token's user, and
// "emaciated" leaves out each goal's graph data, which TallyBee doesn't need.)
async function getGoals() {
  const token = getToken();
  return check(await fetch(`${API}users/me/goals.json?` +
    new URLSearchParams({ access_token: token, emaciated: true }),
    { signal: AbortSignal.timeout(PATIENCE) }), token);
}

// The datapoint added to the user's goal last, or undefined if it has none.
// (A goal's last_datapoint, in what getGoals gets, is the one last added or
// edited.) Beeminder sorts datapoints by when they were added unless told to
// sort them some other way.
async function getLastAdded(goal) {
  const token = getToken();
  return (await check(await fetch(`${API}users/me/goals/${goal}/datapoints.json?` +
    new URLSearchParams({ access_token: token, count: 1 }),
    { signal: AbortSignal.timeout(PATIENCE) }), token))[0];
}

// Add a datapoint to the user's goal and return the datapoint as Beeminder
// saved it. The requestid makes resending the datapoint update it in place
// rather than add a duplicate.
async function addDatapoint(goal, value, comment, requestid) {
  const token = getToken();
  const url = `${API}users/me/goals/${goal}/datapoints.json`;
  return check(await fetch(url, { method: 'POST', body: new URLSearchParams(
    { access_token: token, value, comment, requestid }),
    signal: AbortSignal.timeout(PATIENCE) }), token);
}

export {
  REAUTH,
  UNASKED,
  assert,
  login,
  autoLogin,
  getUsername,
  getGoals,
  getLastAdded,
  addDatapoint
}
