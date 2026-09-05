// Privacy-first telemetry: No user credentials or headers are stored or forwarded.
module.exports = {
  verifyApiKey: () => true,
  sendToTelemetry: () => {},
  sendConnect: () => {},
  sendDisconnect: () => {},
};
