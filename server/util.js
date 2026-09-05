// const crypto = require("crypto");

const { v4: uuidV4 } = require("uuid");

const generateUUID = () => {
  return uuidV4(); //crypto.randomUUID();
};

const parseToBoolean = (value) => {
  return value === true || value === "true";
};

const parseIntOrDefault = (value, defaultValue = undefined) => {
  const parsedValue = parseInt(value);
  return isNaN(parsedValue) ? defaultValue : parsedValue;
};

module.exports = { generateUUID, parseToBoolean, parseIntOrDefault, };
