/**
 * The main code for the background page.
 * Manages connections, settings, the miniplayer and much more.
 * @author Sven Recknagel (svenrecknagel@googlemail.com)
 * Licensed under the BSD license
 */
var LOCAL_SETTINGS_DEFAULTS = {
  lastfmSessionKey: null,
  lastfmSessionName: null,
  syncSettings: false,
  miniplayerSizing: {
    normal:   { width: 271, height: 116, left: 0, top: 0 },
    compact1: { width: 271, height: 84, left: 0, top: 0 },
    compact2: { width: 180, height: 133, left: 0, top: 0 },
    hbar:     { width: 476, height: 31,  left: 0, top: 0 }
  }
}
var localSettings = new Bean(LOCAL_SETTINGS_DEFAULTS, true);
var SETTINGS_DEFAULTS = {
  scrobble: true,
  scrobblePercent: 50,
  scrobbleTime: 240,
  scrobbleMaxDuration: 30,
  disableScrobbleOnFf: false,
  linkRatings: false,
  toast: true,
  toastDuration: 5,
  hideToastPlaycontrols: true,
  miniplayerType: "popup",
  layout: "normal",
  color: "turq",
  iconClickMiniplayer: false,
  iconClickConnect: false,
  openGoogleMusicPinned: false,
  updateNotifier: true,
  gaEnabled: true
};
var settings = new Bean(SETTINGS_DEFAULTS, true);

var miniplayer;
var toast;
var googlemusicport;
var googlemusictabId;
var optionsTabId;
var justOpenedClass;
var parkedPorts = [];
var viewUpdateNotifier = localStorage["viewUpdateNotifier"] || false;
var previousVersion = localStorage["previousVersion"];

var SONG_DEFAULTS = {
  position: "0:00",
  positionSec: 0,
  info: null,
  rating: 0,
  nowPlayingSent: false,
  scrobbled: false,
  toasted: false,
  scrobbleTime: -1,
  timestamp: 0,
  ff: false
};
var PLAYER_DEFAULTS = {
  ratingMode: null,
  shuffle: "",
  repeat: "",
  playlists: [],
  playing: false
};
var player = new Bean(PLAYER_DEFAULTS);
var song = new Bean(SONG_DEFAULTS);

var LASTFM_APIKEY = "1ecc0b24153df7dc6ac0229d6fcb8dda";
var LASTFM_APISECRET = "fb4b74854f7a7b099c30bfe71236dfd5";
var lastfm = new LastFM({apiKey: LASTFM_APIKEY, apiSecret: LASTFM_APISECRET});
lastfm.session.key = localSettings.lastfmSessionKey;
lastfm.session.name = localSettings.lastfmSessionName;

var currentVersion = chrome.runtime.getManifest().version;

function equalsCurrentSong(info, old) {
  if (old == info) return true;//both null
  if (old != null && info != null
      && old.duration == info.duration
      && old.title == info.title
      && old.artist == info.artist
      && old.album == info.album) {
    return true;
  }
  return false;
}
song.setEqualsFn("info", equalsCurrentSong);

function updateBrowserActionIcon() {
  var path = "img/icon-";
  if (viewUpdateNotifier) {
    path += "updated";
  } else if (googlemusicport == null) {
    path += "notconnected";
  } else if (song.info) {
    path += player.playing ? "play" : "pause";
    if (song.scrobbled) path += "-scrobbled";
  } else {
    path += "connected";
  }
  chrome.browserAction.setIcon({path: path + ".png"});
}

function removeParkedPort(port) {
  for (var i in parkedPorts) {
    if (port == parkedPorts[i]) {
      parkedPorts.splice(i, 1);
      return;
    }
  }
}

function connectPort(port) {
  port.postMessage({type: "connected"});
  googlemusicport = port;
  googlemusictabId = port.sender.tab.id;
  iconClickSettingsChanged();
  port.onMessage.addListener(onMessageListener);
  port.onDisconnect.addListener(onDisconnectListener);
  updateBrowserActionIcon();
}

function isConnectedTab(port) {
  if (googlemusicport && port.sender.tab.id == googlemusicport.sender.tab.id) return true;
  for (var i in parkedPorts) {
    if (port.sender.tab.id == parkedPorts[i].sender.tab.id) return true;
  }
  return false;
}

function onConnectListener(port) {
  console.assert(port.name == "googlemusic");
  if (isConnectedTab(port)) {
    port.postMessage({type: "alreadyConnected"});
  } else {
    if (googlemusicport) {
      parkedPorts.push(port);
      port.onDisconnect.addListener(removeParkedPort);
    } else {
      connectPort(port);
    }
  }
}

function onDisconnectListener() {
  googlemusicport = null;
  googlemusictabId = null;
  iconClickSettingsChanged();
  
  resetToDefaults(player, PLAYER_DEFAULTS);
  resetToDefaults(song, SONG_DEFAULTS);
  
  //try to connect another tab
  while (parkedPorts.length > 0) {
    var parkedPort = parkedPorts.shift();
    try {
      parkedPort.onDisconnect.removeListener(removeParkedPort);
      connectPort(parkedPort);
      break;
    } catch (e) {
      //seems to be disconnected, try next
    }
  }
  
  if (googlemusicport == null) updateBrowserActionIcon();//disconnected
}

function onMessageListener(message) {
  var val = message.value;
  var type = message.type;
  
  if (type.indexOf("song-") == 0) {
    if (type == "song-position" && val == "") val = SONG_DEFAULTS.position;
    song[type.substring(5)] = val;
  } else if (type.indexOf("player-") == 0) {
    player[type.substring(7)] = val;
  }
}

function isScrobblingEnabled() {
  return settings.scrobble && localSettings.lastfmSessionName != null;
}

function calcScrobbleTime() {
  if (song.info
  && song.info.durationSec > 0
  && isScrobblingEnabled()
  && !(song.ff && settings.disableScrobbleOnFf)
  && !(settings.scrobbleMaxDuration > 0 && song.info.durationSec > (settings.scrobbleMaxDuration * 60))) {
    var scrobbleTime = song.info.durationSec * (settings.scrobblePercent / 100);
    if (settings.scrobbleTime > 0 && scrobbleTime > settings.scrobbleTime) {
      scrobbleTime = settings.scrobbleTime;
    }
    song.scrobbleTime = scrobbleTime;
  } else {
    song.scrobbleTime = -1;
  }
}

function parseSeconds(time) {
  time = time.split(':');
  var sec = 0;
  var factor = 1;
  for (var i = time.length - 1; i >= 0; i--) {
    sec += parseInt(time[i], 10) * factor;
    factor *= 60;
  }
  return sec || 0;
}

function scrobble() {
  lastfm.track.scrobble({
      track: song.info.title,
      timestamp: song.timestamp,
      artist: song.info.artist,
      album: song.info.album,
      duration: song.info.durationSec
    },
    {
      success: function(response) { gaEvent('LastFM', 'ScrobbleOK'); },
      error: function(code) { gaEvent('LastFM', 'ScrobbleError-' + code); }
    }
  );
}

function sendNowPlaying() {
  lastfm.track.updateNowPlaying({
      track: song.info.title,
      artist: song.info.artist,
      album: song.info.album,
      duration: song.info.durationSec
    },
    {
      success: function(response) { gaEvent('LastFM', 'NowPlayingOK'); },
      error: function(code) { gaEvent('LastFM', 'NowPlayingError-' + code); }
    }
  );
}

function resetToDefaults(bean, defaults) {
  for (var prop in defaults) {
    bean[prop] = defaults[prop];
  }
}

function lastfmLogin() {
  var callbackUrl = chrome.extension.getURL("options.html");
  var url = "http://www.last.fm/api/auth?api_key=" + LASTFM_APIKEY + "&cb=" + callbackUrl;
  if (optionsTabId) {
    chrome.tabs.update(optionsTabId, { url: url, active: true });
  } else {
    chrome.tabs.create({ url: url });
  }
  gaEvent('LastFM', 'AuthorizeStarted');
}

function lastfmLogout() {
  lastfm.session = {};
  localSettings.lastfmSessionKey = null;
  localSettings.lastfmSessionName = null;
}

function relogin() {
  lastfmLogout();
  var notification = webkitNotifications.createNotification(
    "img/icon-48x48.png",
    chrome.i18n.getMessage("lastfmSessionTimeout"),
    chrome.i18n.getMessage("lastfmRelogin")
  );
  notification.onclick = function() {
    lastfmLogin();
    notification.cancel();
  };
  notification.show();
}
lastfm.sessionTimeoutCallback = relogin;

function toastPopup() {
  if (!song.toasted && settings.toast && !miniplayer) {
    song.toasted = true;
    justOpenedClass = "toast";
    if (toast) toast.cancel();
    toast = webkitNotifications.createHTMLNotification('player.html');
    toast.show();
    toast.onclose = function() {
      toast = null;
    };
  }
}

var miniplayerReopen = false;
function miniplayerClosed(winId) {
  if (miniplayer) {
    if (typeof(winId) == "number") {
      if (winId == miniplayer.id) chrome.windows.onRemoved.removeListener(miniplayerClosed);
      else return;//some other window closed
    }
    miniplayer = null;
    if (miniplayerReopen) openMiniplayer();
    miniplayerReopen = false;
  }
}

function getMiniplayerSizing() {
  var addToHeight = {normal: 113, popup: 38, panel: 37, detached_panel: 37};
  var addToWidth = {normal: 16, popup: 16, panel: -1, detached_panel: -1};
  var sizing = localSettings.miniplayerSizing[settings.layout];
  var result = {
    height: sizing.height + addToHeight[settings.miniplayerType],
    width: sizing.width + addToWidth[settings.miniplayerType],
    top: sizing.top,
    left: sizing.left
  };
  return result;
}

function openMiniplayer() {
  if (toast) toast.cancel();
  if (miniplayer) {//close first
    miniplayerReopen = true;
    if (miniplayer instanceof Notification) {
      miniplayer.cancel();
    } else {
      chrome.windows.remove(miniplayer.id);
    }
    //miniplayerClosed callback will open it again
    return;
  }
  
  justOpenedClass = "miniplayer";
  if (settings.miniplayerType == "notification") {
    miniplayer = webkitNotifications.createHTMLNotification('player.html');
    miniplayer.show();
    miniplayer.onclose = miniplayerClosed;
  } else {
    var sizing = getMiniplayerSizing();
    chrome.windows.create({
        url: chrome.extension.getURL("player.html"),
        height: sizing.height,
        width: sizing.width,
        top: sizing.top,
        left: sizing.left,
        type: settings.miniplayerType
      }, function(win) {
        miniplayer = win;
        chrome.windows.onRemoved.addListener(miniplayerClosed);
      }
    );
  }
  gaEvent('Internal', miniplayerReopen ? 'MiniplayerReopened' : 'MiniplayerOpened');
}

function iconClickSettingsChanged() {
  chrome.browserAction.onClicked.removeListener(openGoogleMusicTab);
  chrome.browserAction.onClicked.removeListener(openMiniplayer);
  chrome.browserAction.setPopup({popup: ""});
  if (viewUpdateNotifier) {
    chrome.browserAction.setPopup({popup: "updateNotifier.html"});
  } else if (settings.iconClickConnect && !googlemusicport) {
    chrome.browserAction.onClicked.addListener(openGoogleMusicTab);
  } else if (settings.iconClickMiniplayer) {
    chrome.browserAction.onClicked.addListener(openMiniplayer);
  } else {
    chrome.browserAction.setPopup({popup: "player.html"});
  }
}

function isNewerVersion(version) {
  if (previousVersion == null) return false;
  var prev = previousVersion.split(".");
  version = version.split(".");
  for (var i in prev) {
    if (version.length <= i) return false;//version is shorter (e.g. 1.0 < 1.0.1)
    var p = parseInt(prev[i]);
    var v = parseInt(version[i]);
    if (p != v) return v > p;
  }
  return version.length > prev.length;//version is longer (e.g. 1.0.1 > 1.0), else same version
}

function updatedListener(details) {
  if (details.reason == "update") {
    previousVersion = details.previousVersion;
    if (isNewerVersion(currentVersion)) {
      localStorage["previousVersion"] = previousVersion;
      viewUpdateNotifier = true;
      localStorage["viewUpdateNotifier"] = viewUpdateNotifier;
      iconClickSettingsChanged();
      updateBrowserActionIcon();
    } else {
      previousVersion = null;
    }
  }
}

function updateInfosViewed() {
  previousVersion = null;
  localStorage.removeItem("previousVersion");
  updateNotifierDone();
}

function updateNotifierDone() {
  viewUpdateNotifier = false;
  localStorage.removeItem("viewUpdateNotifier");
  iconClickSettingsChanged();
  updateBrowserActionIcon();
}

function executeInGoogleMusic(command, options) {
  if (googlemusicport) {
    if (options == null) options = {};
    googlemusicport.postMessage({type: "execute", command: command, options: options});
  }
}

function gaEvent(category, eventName, value) {
  if (settings.gaEnabled) {
    if (value == undefined) {
      _gaq.push(['_trackEvent', category, eventName, currentVersion]);
    } else {
      _gaq.push(['_trackEvent', category, eventName, currentVersion, value]);
    }
  }
}

function recordSetting(prop) {
  var value = settings[prop];
  switch (typeof(value)) {
    case "boolean":
      gaEvent("Settings", prop + (value ? "-On" : "-Off"));
      break;
    case "number":
      gaEvent("Settings", prop, value);
      break;
    default:
      gaEvent("Settings", prop + "-" + value);
  }
}

function gaEnabledChanged(val) {
  if (val) {
    settings.removeListener("gaEnabled", gaEnabledChanged);//init/record only once
    initGA(currentVersion);
    var settingsToRecord = [
      "scrobble",
      "scrobblePercent",
      "scrobbleTime",
      "scrobbleMaxDuration",
      "disableScrobbleOnFf",
      "linkRatings",
      "toast",
      "toastDuration",
      "hideToastPlaycontrols",
      "miniplayerType",
      "layout",
      "color",
      "iconClickMiniplayer",
      "iconClickConnect",
      "openGoogleMusicPinned",
      "updateNotifier"
    ];
    for (var i in settingsToRecord) {
      recordSetting(settingsToRecord[i]);
    }
  }
}

function openOptions() {
  if (optionsTabId) {
    chrome.tabs.update(optionsTabId, {active: true});
  } else {
    chrome.tabs.create({url: chrome.extension.getURL("options.html")});
  }
}

function openGoogleMusicTab() {
  if (googlemusictabId) {
    chrome.tabs.update(googlemusictabId, {active: true});
  } else {
    chrome.tabs.create({url: 'http://play.google.com/music/listen', pinned: settings.openGoogleMusicPinned});
  }
}

function connectGoogleMusicTabs() {
  chrome.tabs.query({url:"*://play.google.com/music/listen*"}, function(tabs) {
    for (var i in tabs) {
      var tabId = tabs[i].id;
      chrome.tabs.executeScript(tabId, {file: "js/jquery-2.0.2.min.js"});
      chrome.tabs.executeScript(tabId, {file: "js/cs.js"});
    }
  });
}
settings.watch("updateNotifier", function(val) {
  if (val) chrome.runtime.onInstalled.addListener(updatedListener)
  else chrome.runtime.onInstalled.removeListener(updatedListener);
});
settings.watch("gaEnabled", gaEnabledChanged);
settings.watch("iconClickMiniplayer", iconClickSettingsChanged);
settings.addListener("iconClickConnect", iconClickSettingsChanged);
settings.addListener("miniplayerType", function() {
  if (miniplayer) openMiniplayer();//reopen
});
settings.addListener("layout", function(val) {
  if (miniplayer && !(miniplayer instanceof Notification)) {
    var sizing = getMiniplayerSizing();
    chrome.windows.update(miniplayer.id, {
        height: sizing.height,
        width: sizing.width
      }
    );
  }
});
settings.addListener("scrobble", calcScrobbleTime);
settings.addListener("scrobbleMaxDuration", calcScrobbleTime);
settings.addListener("scrobblePercent", calcScrobbleTime);
settings.addListener("scrobbleTime", calcScrobbleTime);
settings.addListener("disableScrobbleOnFf", calcScrobbleTime);

localSettings.watch("syncSettings", function(val) {
  settings.setSyncStorage(val, function() {
    if (optionsTabId) chrome.tabs.reload(optionsTabId);
  });
});
localSettings.addListener("lastfmSessionName", calcScrobbleTime);

player.addListener("playing", updateBrowserActionIcon);
song.addListener("scrobbled", updateBrowserActionIcon);
song.addListener("position", function(val) {
  var oldPos = song.positionSec;
  song.positionSec = parseSeconds(val);
  if (!song.ff && song.positionSec > oldPos + 5) {
    song.ff = true;
    song.scrobbleTime = -1;
  } else if (song.ff && song.positionSec <= 5) {//prev pressed or gone back
    song.ff = false;
    calcScrobbleTime();
  }
  if (player.playing && song.info && isScrobblingEnabled()) {
    if (!song.nowPlayingSent && song.positionSec >= 3) {
      song.nowPlayingSent = true;
      sendNowPlaying();
    } else if (!song.scrobbled && song.scrobbleTime >= 0 && song.positionSec >= song.scrobbleTime) {
      song.scrobbled = true;
      scrobble();
    }
  }
});
song.addListener("info", function(val) {
  song.nowPlayingSent = false;
  song.scrobbled = false;
  song.toasted = false;
  song.ff = false;
  if (val) {
    song.info.durationSec = parseSeconds(val.duration);
    song.timestamp = Math.round(new Date().getTime() / 1000);
    if (player.playing) toastPopup();
  } else {
    song.timestamp = 0;
  }
  calcScrobbleTime();
  updateBrowserActionIcon();
});

function reloadForUpdate() {
  var backup = {};
  backup.miniplayerOpen = miniplayer != null;
  backup.nowPlayingSent = song.nowPlayingSent;
  backup.scrobbled = song.scrobbled;
  backup.toasted = song.toasted;
  backup.songTimestamp = song.timestamp;
  backup.songFf = song.ff;
  backup.songPosition = song.position;
  backup.songInfo = song.info;
  localStorage["updateBackup"] = JSON.stringify(backup);
  //sometimes the onDisconnect listener in the content script is not triggered on reload(), so explicitely disconnect here
  if (googlemusicport) {
    googlemusicport.onDisconnect.removeListener(onDisconnectListener);
    googlemusicport.disconnect();
  }
  for (var i in parkedPorts) {
    parkedPorts[i].onDisconnect.removeListener(removeParkedPort);
    parkedPorts[i].disconnect();
  }
  chrome.runtime.reload();
}

if (localStorage["updateBackup"] != null) {
  var updateBackup = JSON.parse(localStorage["updateBackup"]);
  localStorage.removeItem("updateBackup");
  song.position = updateBackup.songPosition;
  song.ff = updateBackup.songFf;
  song.info = updateBackup.songInfo;
  song.nowPlayingSent = updateBackup.nowPlayingSent;
  song.scrobbled = updateBackup.scrobbled;
  song.toasted = updateBackup.toasted;
  song.timestamp = updateBackup.songTimestamp;
  if (updateBackup.miniplayerOpen) openMiniplayer();
  updateBackup = null;
}

chrome.commands.onCommand.addListener(function(command) {
  switch (command) {
    case "playPause":
    case "prevSong":
    case "nextSong":
      executeInGoogleMusic(command);
      break;
    case "openMiniplayer":
      openMiniplayer();
      break;
  }
});

chrome.extension.onConnect.addListener(onConnectListener);
chrome.runtime.onUpdateAvailable.addListener(reloadForUpdate);
chrome.runtime.onSuspend.addListener(function() {
  chrome.runtime.onUpdateAvailable.removeListener(reloadForUpdate);
});

connectGoogleMusicTabs();
