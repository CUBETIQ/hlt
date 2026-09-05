import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PROFILE_DEFAULT, PROFILE_PATH } from "./constant";

export const listProfile = () => {
    const configDir = path.resolve(os.homedir(), PROFILE_PATH);
    if (!fs.existsSync(configDir)) {
        console.log(`config file ${configDir} not found`);
        return;
    }

    const configFiles = fs.readdirSync(configDir);
    if (configFiles.length === 0) {
        console.log(`config file ${configDir} not found`);
        return;
    }

    console.log("List of profile:");
    configFiles.forEach((file) => {
        const configFilePath = path.resolve(configDir, file);
        const config = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
        const name = file.replace(".json", "");
        console.log(`- ${name} (${config.clientId})`);
    });

    console.log(`\nCurrent profile: ${PROFILE_DEFAULT}`);
}