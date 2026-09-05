const fs = require("fs");
const logger = require("./logger");

// Load the build.json to BuildInfo
const buildFilePath = `${__dirname}/build.json`;
let buildInfo = undefined;
if (fs.existsSync(buildFilePath)) {
  try {
    const buildPath = require.resolve(buildFilePath);
    buildInfo = require(buildPath);
  } catch (error) {
    logger.error("Failed to load build.json", error);
  }
}

if (buildInfo) {
  logger.info(
    `[HTS] Version: ${buildInfo.version}, Commit: ${buildInfo.commit}, Build Time: ${buildInfo.build_time}`,
  );
} else {
  buildInfo = {
    version: "dev",
    commit: "-",
    build_time: "-",
  };
}

module.exports = buildInfo;
