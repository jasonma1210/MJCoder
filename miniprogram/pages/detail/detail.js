// 任务详情：报告/diff 摘要 + 审批（review 态）
const api = require('../../utils/api');

Page({
  data: { run: null, report: null, diffPreview: '', note: '', loading: true, error: '', actionable: false },

  onLoad(query) {
    this.runId = query.runId;
    this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const run = await api.getTask(this.runId);
      this.setData({
        run,
        report: run.report || null,
        diffPreview: (run.diff || '').slice(0, 2000),
        actionable: run.state === 'review',
        loading: false,
      });
    } catch (err) {
      this.setData({ error: err.message, loading: false });
    }
  },

  onNote(e) { this.setData({ note: e.detail.value }); },

  async decide(e) {
    const decision = e.currentTarget.dataset.decision; // approve | reject
    try {
      await api.approveTask(this.runId, decision, this.data.note);
      wx.showToast({ title: decision === 'approve' ? '已批准' : '已拒绝', icon: 'success' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    }
  },
});
