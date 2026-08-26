// Hook into Node.js require to ignore CSS imports
// @antv/s2 has CSS imports that break in server-side rendering
const Module = require("module");
const originalLoader = Module._extensions[".js"];

Module._extensions[".css"] = function (_module, filename) {
  // Return an empty module for CSS files
  _module.exports = "";
};

// Also handle .less files
Module._extensions[".less"] = function (_module, filename) {
  _module.exports = "";
};