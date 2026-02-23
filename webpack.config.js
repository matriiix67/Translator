const path = require("path");
const CopyWebpackPlugin = require("copy-webpack-plugin");

/**
 * @param {unknown} _env
 * @param {{mode?: "development" | "production"}} argv
 * @returns {import("webpack").Configuration}
 */
module.exports = (_env, argv) => {
  const mode = argv.mode ?? "development";

  return {
    mode,
    devtool: mode === "development" ? "inline-source-map" : false,
    entry: {
      background: "./src/background/service-worker.ts",
      content: "./src/content/index.ts",
      youtube: "./src/youtube/index.ts",
      "youtube/page-bridge": "./src/youtube/page-bridge.ts",
      popup: "./src/popup/popup.ts",
      options: "./src/options/options.ts"
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].js",
      clean: false
    },
    resolve: {
      extensions: [".ts", ".js"],
      alias: {
        "@shared": path.resolve(__dirname, "src/shared"),
        "@content": path.resolve(__dirname, "src/content"),
        "@youtube": path.resolve(__dirname, "src/youtube"),
        "@background": path.resolve(__dirname, "src/background")
      }
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: "ts-loader",
          exclude: /node_modules/
        }
      ]
    },
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: "manifest.json", to: "manifest.json" },
          { from: "src/popup/popup.html", to: "popup.html" },
          { from: "src/popup/popup.css", to: "popup.css" },
          { from: "src/options/options.html", to: "options.html" },
          { from: "src/options/options.css", to: "options.css" },
          { from: "src/styles/translation.css", to: "styles/translation.css" },
          { from: "icons", to: "icons", noErrorOnMissing: true }
        ]
      })
    ]
  };
};
