// Central error handler - keep every route's try/catch calling next(err)
// so all errors end up here with a consistent JSON shape.
function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
  });
}

module.exports = errorHandler;
