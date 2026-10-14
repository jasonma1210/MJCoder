// async 路由包装器：统一捕获 Promise  rejection 交错误中间件（Express 4 不自动捕获）
module.exports = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
