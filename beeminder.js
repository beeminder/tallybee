/*******************************************************************************
 * Everything here is thanks to Christopher Moravec so far; we probably want
 * this to be a Beeminder-hosted thing?
 ******************************************************************************/

function getTokenObj() {
  const tokenObj = localStorage.getItem('beeminder-token');
  if (!tokenObj) {
    throw new Error("No token! you must call autoLogin first");
  } 

  const token = JSON.parse(tokenObj);
  return token;
}

function getUsername() { return getTokenObj().user }
function getToken()    { return getTokenObj().token }


async function sendBeeminderUrl(urlPart, data) {  
  const token = getToken();
  // example urlPart: me.json
  const url = `https://www.beeminder.com/api/v1/${urlPart}?access_token=${token}`;
  if (!data) {
    const response = await fetch(url);
    console.log(`DEBUG1: ${JSON.stringify(response)}`)
    return response;
  }
  const options = {
    method: 'POST',
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  };
  const response = await fetch(url, options);
  console.log(`DEBUG2: ${JSON.stringify(response)}`)
  return response;
}

function logout() {
  localStorage.removeItem('beeminder-token');
}

function login(clientId, redirectUrl) {
  const rUrl = redirectUrl || window.location.href;
  if (!clientId) {
    throw new Error("clientId must be specified");
  }
  console.debug(`Login: ${clientId} @ ${rUrl} `);
  // build url
  const loginUrl = `https://www.beeminder.com/apps/authorize?client_id=${clientId}&redirect_uri=${rUrl}&response_type=token`;
  console.debug(`Url: ${loginUrl}`);

  // send user to the login page
  window.location.href = loginUrl;
  
}

function autoLogin(clientId, redirectUrl) {
  // check to see if there is a token in local storage, if yes, we are done.
  // check for URL parameters that mean we have an error logging in or we just got a redirect

  if (localStorage.getItem('beeminder-token')) {
    console.debug("User already logged in");
    // already logged in
    return true;
  }

  // example url that means the user denied the app access
  // https://beeminderjsapisample.morehavoc.repl.co/?error=access_denied&error_description=The+user+denied+you+access

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('error')) {
    console.error(`User denied access`);
    console.error(urlParams.get('error'));
    console.error(urlParams.get('error_description'));
    return false;
  }

  // example url that means the user granted app access
  // https://beeminderjsapisample.morehavoc.repl.co/?access_token=cbiwsqs339yvv8ahtskrvs2ak&username=morehavoc

  if (urlParams.has('access_token')) {
    console.debug("User granted access!");
    const tokenObj = {
      token: urlParams.get('access_token'),
      user:  urlParams.get('username'),
    };
    localStorage.setItem('beeminder-token',JSON.stringify(tokenObj));
    // remove access_token from url
    window.history.pushState({}, document.title, window.location.pathname);
    return true;
  }

  // we got here, so we must need to do a login
  login(clientId, redirectUrl);
}



async function getGoals() {
  const r = await sendBeeminderUrl(`users/${getUsername()}.json`);
  if (r.status !== 200) {
    console.log("DEBUG 3: non 200", r)
    return {error: "Non-200 response from "}
  }
  else {
    const userJ = await r.json();
    return userJ.goals;
  }
}

async function addDatapoint(goal, value, comment) {
  const url = `users/${getUsername()}/goals/${goal}/datapoints.json`;
  const data = {value: value, comment};

  const r = await sendBeeminderUrl(url, data);
  const rj = await r.json();
  return rj;
}

export {
  logout,
  login,
  autoLogin,
  getGoals,
  addDatapoint
}
