const stats = {};

const getStats = (host) => {
  return (
    stats[host] || {
      http_count: 0,
      ws_count: 0,
    }
  );
};

const initStats = (host, socket) => {
  if (stats[host]) {
    stats[host].started_time = new Date().getTime();
  } else {
    stats[host] = {
      ws_count: 0,
      http_count: 0,
      created_time: new Date().getTime(),
      started_time: new Date().getTime(),
    };
  }
};

const saveStats = (host, socket) => {
  if (stats[host]) {
    stats[host].http_count = stats[host].http_count + 1;
  } else {
    stats[host] = {
      ws_count: 0,
      http_count: 1,
    };
  }
};

const saveStatsWs = (host, socket) => {
  if (stats[host]) {
    stats[host].ws_count = stats[host].ws_count + 1;
  } else {
    stats[host] = {
      ws_count: 1,
      http_count: 0,
    };
  }
};

const deleteStats = (host) => {
  delete stats[host];
};

module.exports = {
  initStats,
  saveStats,
  saveStatsWs,
  deleteStats,
  getStats,
};
