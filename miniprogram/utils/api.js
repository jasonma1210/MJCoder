// 网关 API 封装：JWT 鉴权 + 统一错误
const app = getApp();

function request(path, method = 'GET', data = null) {
  const token = app.globalData.token || wx.getStorageSync('mj_token');
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${app.globalData.baseUrl}${path}`,
      method,
      data,
      header: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      success: (res) => {
        if (res.statusCode === 401) {
          wx.clearStorage();
          wx.reLaunch({ url: '/pages/login/login' });
          reject(new Error('登录已过期'));
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error((res.data && res.data.error) || `请求失败 ${res.statusCode}`));
          return;
        }
        resolve(res.data);
      },
      fail: (err) => reject(new Error(err.errMsg || '网络异常')),
    });
  });
}

// 绑定态轮询：凭临时 mpToken 查询桌面端是否已确认，确认后签发正式小程序 JWT
function checkSession() {
  const mpToken = wx.getStorageSync('mj_mp_token');
  const app = getApp();
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${app.globalData.baseUrl}/auth/mp-session`,
      method: 'GET',
      header: { Authorization: `Bearer ${mpToken}` },
      success: (res) => {
        if (res.statusCode === 401) {
          reject(new Error('绑定尚未确认或临时凭证已过期'));
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error((res.data && res.data.error) || `请求失败 ${res.statusCode}`));
          return;
        }
        resolve(res.data);
      },
      fail: (err) => reject(new Error(err.errMsg || '网络异常')),
    });
  });
}

// 登录绑定：wx.login code → 网关换绑定码 → 桌面端扫码确认（POST /api/auth/mp-bind 由桌面端发起）
function bindWithWeChat() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        request('/auth/mp-bind', 'POST', { code: res.code })
          .then(resolve)
          .catch(reject);
      },
      fail: (err) => reject(new Error('微信登录失败：' + err.errMsg)),
    });
  });
}

module.exports = {
  request,
  bindWithWeChat,
  checkSession,
  // 云端任务（契约见 server/src/routes/cloud.js）
  listTasks: () => request('/cloud/tasks'),
  getTask: (runId) => request(`/cloud/tasks/${runId}`),
  approveTask: (runId, decision, note) => request(`/cloud/tasks/${runId}/approve`, 'POST', { decision, note }),
};
