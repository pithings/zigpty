// import { execSync } from "node:child_process";
import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: "./node/index.ts",
    },
  ],
  // hooks: {
  //   end() {
  //     execSync("zig build --release", { stdio: "inherit" });
  //   },
  // },
});
