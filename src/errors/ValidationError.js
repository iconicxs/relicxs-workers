class ValidationError extends Error {
  constructor(message, field = null, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "ValidationError";
    this.field = field;
    this.code = code;
  }
}

// Export using module alias convention
module.exports = ValidationError;
