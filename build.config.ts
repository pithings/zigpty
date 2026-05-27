// import { execSync } from "node:child_process";
import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: ["./src/index.ts", "./src/osc/index.ts", "./src/idle/index.ts"],
    },
  ],
  // hooks: {
  //   end() {
  //     execSync("zig build --release", { stdio: "inherit" });
  //   },
  // },
});
