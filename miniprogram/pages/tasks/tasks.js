// 云端任务列表：分状态筛选 + 下拉刷新 + 轮询兜底
const api = require('../../utils/api');

Page({
  data: { tasks: [], filter: 'all', loading: false, error: '' },

  onShow() { this.load(); },

  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const list = await api.listTasks();
      const filtered = this.data.filter === 'all'
        ? list
        : list.filter((t) => t.state === this.data.filter);
      this.setData({ tasks: filtered, loading: false });
    } catch (err) {
      this.setData({ error: err.message, loading: false });
    }
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.state }, () => this.load());
  },

  openDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?runId=${e.currentTarget.dataset.id}` });
  },
});
