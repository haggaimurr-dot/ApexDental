const api = require('./api')
const labels = { pending: '等待发送', blocked: '站内消息兜底', sending: '发送中', retry: '等待自动重试', failed: '发送失败', uncertain: '发送结果未知', sent: '微信已发送', obsolete: '已失效' }
module.exports = {
  clearNotifications() {
    this.notificationEpoch = (this.notificationEpoch || 0) + 1
    this.setData({ notificationItems: [], notificationPage: 0, notificationTotal: 0, notificationUnread: 0, notificationHasMore: false,
      notificationLoading: false, notificationBusy: false, notificationError: '', notificationSettings: null, notificationFilter: '' })
  },
  notificationGuard() {
    const epoch = this.notificationEpoch, profile = this.data.profile, tab = this.data.tab, page = this.data.page
    return () => epoch === this.notificationEpoch && profile === this.data.profile && tab === this.data.tab && page === this.data.page
  },
  showNotifications() {
    if (!this.data.authReady) return this.showError(new Error('请先连接服务并登录'))
    this.clearNotifications(); this.setData({ page: 'notifications' }); return this.loadNotifications()
  },
  showNotificationAdmin() {
    if (this.data.tab !== 'clinic' || this.data.profile?.role !== 'admin') return
    this.clearNotifications(); this.setData({ page: 'notification-admin' }); return this.loadNotifications()
  },
  loadNotifications(more = false) {
    if (typeof more !== 'boolean') more = false
    if (!['notifications', 'notification-admin'].includes(this.data.page) || this.data.notificationLoading || more && !this.data.notificationHasMore) return Promise.resolve()
    const current = this.notificationGuard(), admin = this.data.page === 'notification-admin', page = more ? this.data.notificationPage + 1 : 1
    this.setData({ notificationLoading: true, notificationError: '' })
    return Promise.all([api.notifications(page, admin, this.data.notificationFilter), admin ? Promise.resolve(null) : api.notificationSettings()])
      .then(([result, settings]) => { if (current()) this.setData({ notificationItems: [...(more ? this.data.notificationItems : []), ...result.items.map(m => ({ ...m,
        statusLabel: labels[m.status], timeLabel: new Date(new Date(m.createdAt).getTime() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') }))],
        notificationPage: page, notificationTotal: result.total, notificationUnread: result.unread, notificationHasMore: result.hasMore, notificationSettings: settings }) })
      .catch(error => { if (current()) this.setData({ notificationError: error.message }) })
      .finally(() => { if (current()) this.setData({ notificationLoading: false }) })
  },
  moreNotifications() { return this.loadNotifications(true) },
  filterNotifications(e) {
    if (this.data.notificationLoading || this.data.notificationBusy) return
    this.setData({ notificationFilter: e.currentTarget.dataset.status }); return this.loadNotifications()
  },
  subscribeReminder(e) {
    const templateId = e.currentTarget.dataset.id
    if (this.data.notificationBusy || !this.data.notificationSettings?.ready) return
    const current = this.notificationGuard()
    this.setData({ notificationBusy: true, notificationError: '' })
    // Called synchronously from the patient's tap. One template per tap stays within WeChat's limit.
    wx.requestSubscribeMessage({ tmplIds: [templateId],
      success: result => {
        if (!current()) return
        api.subscribeNotifications([{ templateId, choice: result[templateId] }]).then(settings => {
          if (current()) { this.setData({ notificationSettings: settings }); wx.showToast({ title: result[templateId] === 'accept' ? '已申请本次订阅' : '已保留站内提醒', icon: 'none' }) }
        }).catch(error => { if (current()) this.setData({ notificationError: error.message }) })
          .finally(() => { if (current()) this.setData({ notificationBusy: false }) })
      },
      fail: () => { if (current()) this.setData({ notificationError: '订阅申请未完成，仍可查看站内消息', notificationBusy: false }) }
    })
  },
  readNotification(e) {
    if (this.data.notificationBusy) return
    const id = e.currentTarget.dataset.id, current = this.notificationGuard()
    this.setData({ notificationBusy: true })
    return api.readNotification(id).then(() => { if (current()) { this.setData({ notificationItems: this.data.notificationItems.map(m => m.id === id ? { ...m, read: true } : m) }); return this.loadNotifications() } })
      .catch(error => { if (current()) this.setData({ notificationError: error.message }) })
      .finally(() => { if (current()) this.setData({ notificationBusy: false }) })
  },
  openNotification(e) {
    const message = this.data.notificationItems.find(m => m.id === e.currentTarget.dataset.id)
    if (!message || message.obsolete) return
    this.setData({ memberFilter: 'all' })
    if (message.kind === 'care') return this.showCare()
    if (message.kind === 'recall') return this.showRecalls()
    this.showAppointments(); return this.refreshRemote()
  },
  retryNotification(e) {
    if (this.data.notificationBusy) return
    const id = e.currentTarget.dataset.id, message = this.data.notificationItems.find(m => m.id === id), current = this.notificationGuard()
    if (!message?.canRetry) return
    wx.showModal({ title: '重试微信推送', content: message.status === 'uncertain' ? '上次消息可能已经送达。请先核实，继续重试可能重复发送。' : '请先核实微信配置及用户订阅授权。重试会再次尝试发送当前提醒。',
      success: result => {
        if (!result.confirm || !current()) return
        this.setData({ notificationBusy: true })
        api.retryNotification(id).then(() => { if (current()) return this.loadNotifications() })
          .catch(error => { if (current()) this.setData({ notificationError: error.message }) })
          .finally(() => { if (current()) this.setData({ notificationBusy: false }) })
      } })
  }
}
