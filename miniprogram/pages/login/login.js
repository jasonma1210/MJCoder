// 登录绑定页：微信登录 → 换取绑定码 → 桌面端扫码确认
const api = require('../../utils/api');

Page({
  data: { bindCode: '', loading: false, error: '' },

  async onBind() {
    this.setData({ loading: true, error: '' });
    try {
      const r = await api.bindWithWeChat();
      // 网关返回一次性绑定码 + 临时 mpToken；桌面端「设置 → 账户」输入该码完成关联
      wx.setStorageSync('mj_mp_token', r.mpToken || '');
      this.setData({ bindCode: r.bindCode || '' });
    } catch (err) {
      this.setData({ error: err.message });
    }
    this.setData({ loading: false });
  },

  copyCode() {
    if (this.data.bindCode) {
      wx.setClipboardData({ data: this.data.bindCode });
    }
  },

  async checkBound() {
    // 凭临时 mpToken 轮询绑定状态；桌面确认后网关签发正式小程序 JWT
    try {
      const r = await api.checkSession();
      if (r && r.token) {
        const app = getApp();
        app.globalData.token = r.token;
        wx.setStorageSync('mj_token', r.token);
        wx.removeStorageSync('mj_mp_token'); // 临时凭证一次性消费
        wx.redirectTo({ url: '/pages/tasks/tasks' });
      } else {
        this.setData({ error: '桌面端尚未确认绑定' });
      }
    } catch (err) {
      this.setData({ error: err.message });
    }
  },
});
