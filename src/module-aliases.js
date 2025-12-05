// Root module-alias configuration for relicxs-workers
// CommonJS only

const path = require("path");
const moduleAlias = require("module-alias");

moduleAlias.addAliases({
  "@core": path.join(__dirname, "core"),
  "@config": path.join(__dirname, "core/config"),
  "@startup": path.join(__dirname, "startup"),
  "@resilience": path.join(__dirname, "resilience"),
  "@observability": path.join(__dirname, "observability"),
  "@machinist": path.join(__dirname, "workers/machinist"),
  "@archivist": path.join(__dirname, "workers/archivist"),
  "@events": path.join(__dirname, "events"),
  "@logs": path.join(__dirname, "logs"),
  "@security": path.join(__dirname, "security"),
  "@errors": path.join(__dirname, "errors"),
  "@schema": path.join(__dirname, "schema"),
  "@safety": path.join(__dirname, "safety")
});

module.exports = {};
