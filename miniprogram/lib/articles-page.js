const api = require('./api')
const symptoms = require('./article-symptoms')
const populations = require('./article-populations')
const labels = { draft: '草稿', published: '已发布', offline: '已下架', pending: '待审核', approved: '审核通过', rejected: '已退回' }
const display = row => ({ ...row, symptomLabel: symptoms.filter(entry => (row.symptoms || []).includes(entry.id)).map(entry => entry.name).join(' · '), statusLabel: labels[row.status], dateLabel: new Date(new Date(row.publishedAt || row.updatedAt).getTime() + 8 * 3600000).toISOString().slice(0, 10) })
module.exports = {
  clearArticles() {
    this.articleEpoch = (this.articleEpoch || 0) + 1
    this.setData({ homeArticles: [], homeArticlesLoading: false, homeArticlesError: '', articleItems: [], articleCategories: [], articleQuery: '', articleCategory: '', articleTotal: 0,
      articleKind:'',articlePopulation: '', articleDoctor: '', articleService: '', articleEditorPopulations: [], articleEditorDoctors: [], reviewItems: [], reviewArticle: null, reviewNote: '', reviewStatus: 'pending', reviewPage: 0, reviewHasMore: false, articleMedia: [], articleFavorite: false, articleSymptom: '', articleSymptomName: '', articleEditorSymptoms: [], articlePage: 0, articleHasMore: false, articleLoading: false, articleError: '', selectedArticle: null, articleEditor: null, articleSaving: false, categoryEditor: null })
  },
  articleGuard(key, page) {
    const requestId = (this[key] || 0) + 1, epoch = this.articleEpoch, profile = this.data.profile, tab = this.data.tab
    this[key] = requestId
    return () => this[key] === requestId && this.articleEpoch === epoch && this.data.profile === profile && this.data.tab === tab && (!page || this.data.page === page)
  },
  loadHomeArticles() {
    if (!this.data.authReady || this.data.tab !== 'patient') return Promise.resolve()
    const current = this.articleGuard('homeArticleRequest')
    this.setData({ homeArticlesLoading: true, homeArticlesError: '', homeArticles: [] })
    return api.articles().then(result => { if (current()) this.setData({ homeArticles: result.items.slice(0, 3).map(display) }) })
      .catch(error => { if (current()) this.setData({ homeArticlesError: error.message }) })
      .finally(() => { if (current()) this.setData({ homeArticlesLoading: false }) })
  },
  showArticles() { this.setData({ page: 'articles', selectedArticle: null }); return this.loadArticles() },
  showSymptomArticles(e) {
    const entry = symptoms.find(row => row.id === e.currentTarget.dataset.id)
    if (!entry || this.data.tab !== 'patient') return
    this.setData({ page: 'articles', selectedArticle: null, articleQuery: '', articleCategory: '', articleSymptom: entry.id, articleSymptomName: entry.name, articlePopulation: '', articleDoctor: '', articleService: '' })
    return this.loadArticles()
  },
  articleSymptomChange(e) {
    const id = e.currentTarget.dataset.id, entry = symptoms.find(row => row.id === id)
    if (id && !entry) return
    this.setData({ articleSymptom: id, articleSymptomName: entry ? entry.name : '' })
    return this.loadArticles()
  },
  showArticleAdmin() {
    if (this.data.articleSaving) return
    if (this.data.tab !== 'clinic' || !this.data.profile || !['admin','doctor'].includes(this.data.profile.role)) return
    this.setData({ page: 'articles-admin', articleEditor: null, categoryEditor: null, articleQuery: '', articleCategory: '', articleSymptom: '', articleSymptomName: '', articlePopulation: '', articleDoctor: '', articleService: '' }); return this.loadArticles()
  },
  loadArticles(more = false) {
    if (typeof more !== 'boolean') more = false
    const page = this.data.page, admin = page === 'articles-admin'
    if (!['articles', 'articles-admin'].includes(page) || more && (this.data.articleLoading || !this.data.articleHasMore)) return Promise.resolve()
    const current = this.articleGuard('articleListRequest', page), pageNumber = more ? this.data.articlePage + 1 : 1
    this.setData({ articleLoading: true, articleError: '', ...(!more ? { articleItems: [], articleTotal: 0, articleHasMore: false, articlePage: 0 } : {}) })
    const fetchList=this.data.page==='articles-admin'&&this.data.profile.role==='doctor'?()=>api.featureRequest('GET',`/v1/doctor/articles?q=${encodeURIComponent(this.data.articleQuery)}&category=${encodeURIComponent(this.data.articleCategory)}&page=${pageNumber}`):()=>api.articles(this.data.articleQuery, this.data.articleCategory, pageNumber, admin, this.data.articleSymptom, this.data.articlePopulation, this.data.articleDoctor, this.data.articleService)
    const finalFetch=this.data.articleKind&&this.data.page==='articles'?()=>api.featureRequest('GET',`/v1/articles?kind=${this.data.articleKind}&q=${encodeURIComponent(this.data.articleQuery)}&category=${encodeURIComponent(this.data.articleCategory)}&symptom=${encodeURIComponent(this.data.articleSymptom)}&population=${encodeURIComponent(this.data.articlePopulation)}&page=${pageNumber}`):fetchList
    return finalFetch().then(result => {
      if (current()) this.setData({ articleItems: [...(more ? this.data.articleItems : []), ...result.items.map(display)], articleCategories: result.categories,
        articleTotal: result.total, articlePage: result.page, articleHasMore: result.hasMore })
    }).catch(error => { if (current()) this.setData({ articleError: error.message }) })
      .finally(() => { if (current()) this.setData({ articleLoading: false }) })
  },
  searchArticles() { return this.loadArticles() },
  moreArticles() { return this.loadArticles(true) },
  articleQueryInput(e) {
    this.articleListRequest = (this.articleListRequest || 0) + 1
    this.setData({ articleQuery: e.detail.value, articleItems: [], articleTotal: 0, articleHasMore: false, articleLoading: false, articleError: '' })
  },
  articleCategoryChange(e) { this.setData({ articleCategory: e.currentTarget.dataset.id }); return this.loadArticles() },
  openArticle(e) {
    this.articleDetailId = e.currentTarget.dataset.id
    this.setData({ page: 'article-detail', selectedArticle: null }); return this.loadArticleDetail()
  },
  loadArticleDetail() {
    const current = this.articleGuard('articleDetailRequest', 'article-detail')
    this.setData({ articleLoading: true, articleError: '', selectedArticle: null })
    return api.article(this.articleDetailId).then(async result => { if (!current()) return; this.setData({ selectedArticle: display(result.article) }); api.featureRequest('POST', `/v1/articles/${encodeURIComponent(result.article.id)}/activity`, {kind:'read',source:'article-detail'}).catch(()=>{}); const favorite=await api.featureRequest('GET', `/v1/articles/${encodeURIComponent(result.article.id)}/favorite`).catch(()=>({selected:false})); if(current())this.setData({articleFavorite:favorite.selected}); return this.loadArticleMedia(result.article.media||[],current) })
      .catch(error => { if (current()) this.setData({ articleError: error.message }) })
      .finally(() => { if (current()) this.setData({ articleLoading: false }) })
  },
  bookArticleService() {
    const id = this.articleDetailId, current = this.articleGuard('articleBookingRequest', 'article-detail')
    // Recheck publication and current service availability before starting a booking.
    return api.article(id).then(result => {
      if (!current()) return
      if (!result.article.serviceAvailable) throw new Error('该服务暂未开放，请联系诊所')
      api.featureRequest('POST', `/v1/articles/${encodeURIComponent(id)}/activity`, {kind:'booking',source:'article-detail'}).catch(()=>{})
      return this.loadCatalog().then(() => { if (current()) this.startBooking({ currentTarget: { dataset: { service: result.article.service } } }) })
    }).catch(error => { if (current()) { this.setData({ selectedArticle: null, articleError: error.message }); this.showError(error) } })
  },
  editArticle(e) {
    if (this.data.articleSaving) return
    const id = e.currentTarget.dataset.id
    this.setData({ page: 'article-edit', articleEditor: null, categoryEditor: null, articleError: '', articleLoading: true })
    const current = this.articleGuard('articleEditRequest', 'article-edit')
    const prepare = entry => {
      entry = { ...entry, metadata: {kind:'article',blocks:[],faq:[],references:[],...(entry.metadata||{})}, symptoms: entry.symptoms || [], populations: entry.populations || [], doctorNames: entry.doctorNames || [] }
      const categoryIndex = Math.max(0, this.data.articleCategories.findIndex(row => row.id === entry.categoryId))
      const serviceChoices = ['不关联服务', ...this.data.serviceProfiles.map(row => row.name)]
      if (entry.service && !serviceChoices.includes(entry.service)) serviceChoices.push(entry.service)
      this.setData({ articleEditor: entry, articleMetaFields: [{key:'definition',label:'定义'},{key:'manifestations',label:'表现'},{key:'causes',label:'常见原因'},{key:'consultation',label:'就诊沟通提示'},{key:'examination',label:'检查说明'},{key:'treatment',label:'治疗说明'},{key:'preparation',label:'治疗前准备'},{key:'aftercare',label:'治疗后注意事项'}].map(row=>({...row,value:entry.metadata[row.key]||''})), articleEditorPopulations: populations.map(row => ({ ...row, selected: entry.populations.includes(row.id) })), articleEditorDoctors: [...this.data.doctorProfiles, ...entry.doctorNames.filter(name => !this.data.doctorProfiles.some(row => row.name === name)).map(name => ({ name, id: name }))].map(row => ({ ...row, selected: entry.doctorNames.includes(row.name) })), articleEditorSymptoms: symptoms.map(row => ({ ...row, selected: entry.symptoms.includes(row.id) })), articleCategoryIndex: categoryIndex, articleServiceChoices: serviceChoices,
        articleServiceIndex: entry.service ? serviceChoices.indexOf(entry.service) : 0 })
    }
    return this.loadCatalog().then(() => (id ? (this.data.profile.role==='doctor'?api.featureRequest('GET',`/v1/doctor/articles/${encodeURIComponent(id)}`):api.article(id, true)) : Promise.resolve({ article: { title: '', summary: '', body: '', categoryId: this.data.articleCategories[0]?.id || '', service: '', status: 'draft', version: 0 } })))
      .then(result => { if (current()) prepare(result.article) })
      .catch(error => { if (current()) this.setData({ articleError: error.message }) })
      .finally(() => { if (current()) this.setData({ articleLoading: false }) })
  },
  articleEditorInput(e) {
    const field = e.currentTarget.dataset.field
    if (!this.data.articleSaving && ['title', 'summary', 'body'].includes(field)) this.setData({ [`articleEditor.${field}`]: e.detail.value })
  },
  articleEditorSymptom(e) {
    if (this.data.articleSaving || !this.data.articleEditor) return
    const id = e.currentTarget.dataset.id
    if (!symptoms.some(row => row.id === id)) return
    const tags = this.data.articleEditor.symptoms
    const selected = tags.includes(id) ? tags.filter(tag => tag !== id) : [...tags, id]
    this.setData({ 'articleEditor.symptoms': selected, articleEditorSymptoms: symptoms.map(row => ({ ...row, selected: selected.includes(row.id) })) })
  },
  articleEditorCategory(e) {
    if (!this.data.articleSaving) this.setData({ articleCategoryIndex: Number(e.detail.value), 'articleEditor.categoryId': this.data.articleCategories[Number(e.detail.value)].id })
  },
  articleEditorService(e) {
    if (!this.data.articleSaving) this.setData({ articleServiceIndex: Number(e.detail.value), 'articleEditor.service': Number(e.detail.value) ? this.data.articleServiceChoices[Number(e.detail.value)] : '' })
  },
  saveArticle() {
    if (!this.data.articleEditor || this.data.articleSaving) return
    const current = this.articleGuard('articleSaveRequest', 'article-edit')
    this.setData({ articleSaving: true, articleError: '' })
    const entry=this.data.articleEditor
    return (this.data.profile.role==='doctor'?api.featureRequest(entry.id?'PUT':'POST',`/v1/doctor/articles${entry.id?'/'+encodeURIComponent(entry.id):''}`,entry):api.saveArticle(entry)).then(result => {
      if (current()) { this.setData({ articleEditor: result.article }); wx.showToast({ title: '文章已保存' }) }
    }).catch(error => { if (current()) this.setData({ articleError: error.message }) })
      .finally(() => { if (current()) this.setData({ articleSaving: false }) })
  },
  changeArticleStatus(e) {
    if (this.data.articleSaving) return
    const row = this.data.articleItems.find(row => row.id === e.currentTarget.dataset.id), status = e.currentTarget.dataset.status
    if (!row) return
    const current = this.articleGuard('articleStatusRequest', 'articles-admin')
    this.setData({ articleSaving: true, articleError: '' })
    return api.articleStatus(row.id, row.version, status).then(() => {
      if (current()) { wx.showToast({ title: status === 'published' ? '文章已发布' : '文章已下架' }); return this.loadArticles() }
    }).catch(error => { if (current()) this.setData({ articleError: error.message }) })
      .finally(() => { if (current()) this.setData({ articleSaving: false }) })
  },
  toggleArticleFavorite() {
    if (!this.data.selectedArticle || this.data.articleSaving) return
    const current=this.articleGuard('articleFavoriteRequest','article-detail'),id=this.data.selectedArticle.id
    this.setData({articleSaving:true})
    return api.featureRequest('POST',`/v1/articles/${encodeURIComponent(id)}/favorite`,{selected:!this.data.articleFavorite}).then(result=>{if(current())this.setData({articleFavorite:result.selected})}).catch(error=>{if(current())this.showError(error)}).finally(()=>{if(current())this.setData({articleSaving:false})})
  },
  loadArticleMedia(media,current) {
    this.setData({articleMedia:[]})
    return Promise.all(media.map(async row=>{try{const file=await api.downloadRecordFile(`/v1/content-media/${encodeURIComponent(row.id)}`);if(!current()){wx.getFileSystemManager().unlink({filePath:file,fail:()=>{}});return null}this.extensionFiles=this.extensionFiles||[];this.extensionFiles.push(file);return {...row,path:file,video:row.mime==='video/mp4'}}catch{return {...row,error:'媒体加载失败，请刷新'}}})).then(rows=>{if(current())this.setData({articleMedia:rows.filter(Boolean)})})
  },
  articleMetaInput(e) {
    if(this.data.articleSaving)return
    const field=e.currentTarget.dataset.field
    if(!this.data.articleMetaFields.some(row=>row.key===field))return
    this.setData({[`articleEditor.metadata.${field}`]:e.detail.value,articleMetaFields:this.data.articleMetaFields.map(row=>row.key===field?{...row,value:e.detail.value}:row)})
  },
  articleKindChange(e){if(!this.data.articleSaving)this.setData({'articleEditor.metadata.kind':['article','disease','service'][Number(e.detail.value)]})},
  articleFeaturedChange(e){if(!this.data.articleSaving)this.setData({'articleEditor.metadata.featured':e.detail.value})},
  addArticleFaq(){if(this.data.articleSaving)return;const rows=this.data.articleEditor.metadata.faq;if(rows.length<20)this.setData({'articleEditor.metadata.faq':[...rows,{question:'',answer:''}]})},
  articleFaqInput(e){if(this.data.articleSaving)return;const {index,field}=e.currentTarget.dataset;if(!['question','answer'].includes(field))return;const rows=this.data.articleEditor.metadata.faq.map((row,i)=>i===Number(index)?{...row,[field]:e.detail.value}:row);this.setData({'articleEditor.metadata.faq':rows})},
  removeArticleFaq(e){if(!this.data.articleSaving)this.setData({'articleEditor.metadata.faq':this.data.articleEditor.metadata.faq.filter((row,i)=>i!==Number(e.currentTarget.dataset.index))})},
  uploadArticleMedia(e){
    if(this.data.articleSaving||!this.data.articleEditor?.id)return
    const current=this.articleGuard('articleMediaRequest','article-edit'),id=this.data.articleEditor.id,video=e.currentTarget.dataset.video
    this.setData({articleSaving:true,articleError:''})
    const choose=()=>new Promise((resolve,reject)=>video?wx.chooseVideo({sourceType:['album','camera'],compressed:true,maxDuration:120,success:result=>resolve(result.tempFilePath),fail:reject}):wx.chooseImage({count:1,sizeType:['compressed'],success:result=>resolve(result.tempFilePaths[0]),fail:reject}))
    return choose().then(file=>current()?api.uploadFeatureFile(file,`/v1/admin/content-media/article/${encodeURIComponent(id)}`):null).then(result=>{if(current()&&result)this.setData({articleEditor:result.article})}).catch(error=>{if(current()&&!String(error.errMsg).includes('cancel'))this.setData({articleError:error.message||'媒体上传失败'})}).finally(()=>{if(current())this.setData({articleSaving:false})})
  },
  showKnowledgeKind(e){const kind=e.currentTarget.dataset.kind;if(!['','article','disease','service'].includes(kind))return;this.setData({page:'articles',articleKind:kind,articleQuery:'',articleCategory:'',articleSymptom:'',articleSymptomName:'',articlePopulation:'',articleDoctor:'',articleService:''});return this.loadArticles()},
  articlePopulationChange(e) {
    const id = e.currentTarget.dataset.id
    if (id && !populations.some(row => row.id === id)) return
    this.setData({ articlePopulation: id }); return this.loadArticles()
  },
  showPopulationArticles(e) {
    this.setData({ page: 'articles', articleQuery: '', articleCategory: '', articleSymptom: '', articleSymptomName: '', articleDoctor: '', articleService: '' })
    return this.articlePopulationChange(e)
  },
  showRelatedArticles(e) {
    this.setData({ page: 'articles', articleQuery: '', articleCategory: '', articleSymptom: '', articleSymptomName: '', articlePopulation: '', articleDoctor: e.currentTarget.dataset.doctor || '', articleService: e.currentTarget.dataset.service || '' })
    return this.loadArticles()
  },
  clearArticleRelations() { this.setData({ articleDoctor: '', articleService: '' }); return this.loadArticles() },
  articleEditorTags(e) {
    if (this.data.articleSaving || !this.data.articleEditor) return
    const { field, id } = e.currentTarget.dataset
    if (!['populations', 'doctorNames'].includes(field)) return
    const choices = field === 'populations' ? populations.map(row => row.id) : this.data.articleEditorDoctors.map(row => row.name)
    if (!choices.includes(id)) return
    const tags = this.data.articleEditor[field] || [], selected = tags.includes(id) ? tags.filter(tag => tag !== id) : [...tags, id]
    this.setData({ [`articleEditor.${field}`]: selected, [field === 'populations' ? 'articleEditorPopulations' : 'articleEditorDoctors']: (field === 'populations' ? populations : this.data.articleEditorDoctors).map(row => ({ ...row, selected: selected.includes(field === 'populations' ? row.id : row.name) })) })
  },
  submitArticleReview(e) {
    if (this.data.articleSaving) return
    const row = this.data.articleItems.find(row => row.id === e.currentTarget.dataset.id)
    if (!row) return
    const current = this.articleGuard('articleStatusRequest', 'articles-admin')
    this.setData({ articleSaving: true, articleError: '' })
    return api.reviewArticle(row.id, row.version, e.currentTarget.dataset.decision).then(() => { if (current()) return this.loadArticles() })
      .catch(error => { if (current()) this.setData({ articleError: error.message }) }).finally(() => { if (current()) this.setData({ articleSaving: false }) })
  },
  showContentReviews() {
    if (this.data.articleSaving) return
    if (this.data.tab !== 'clinic' || !['admin', 'doctor'].includes(this.data.profile?.role)) return
    this.setData({ page: 'content-reviews', reviewArticle: null, reviewStatus: 'pending' }); return this.loadContentReviews()
  },
  reviewStatusChange(e) { if (this.data.articleSaving) return; this.reviewDetailRequest = (this.reviewDetailRequest || 0) + 1; this.setData({ reviewStatus: e.currentTarget.dataset.status, reviewArticle: null }); return this.loadContentReviews() },
  loadContentReviews(more = false) {
    if (typeof more !== 'boolean') more = false
    if (this.data.page !== 'content-reviews' || more && (this.data.articleLoading || !this.data.reviewHasMore)) return
    const current = this.articleGuard('reviewListRequest', 'content-reviews'), page = more ? this.data.reviewPage + 1 : 1
    this.setData({ articleLoading: true, articleError: '', ...(!more ? { reviewItems: [], reviewPage: 0, reviewHasMore: false } : {}) })
    return api.contentReviews(this.data.reviewStatus, page).then(result => { if (current()) this.setData({ reviewItems: [...(more ? this.data.reviewItems : []), ...result.items.map(display)], reviewPage: result.page, reviewHasMore: result.hasMore }) })
      .catch(error => { if (current()) this.setData({ articleError: error.message }) }).finally(() => { if (current()) this.setData({ articleLoading: false }) })
  },
  moreContentReviews() { return this.loadContentReviews(true) },
  openContentReview(e) {
    if (this.data.articleSaving) return
    const current = this.articleGuard('reviewDetailRequest', 'content-reviews')
    this.setData({ reviewArticle: null, reviewNote: '', articleError: '', articleLoading: true })
    return api.contentReview(e.currentTarget.dataset.id).then(result => { if (current()) this.setData({ reviewArticle: display(result.article) }) })
      .catch(error => { if (current()) this.setData({ articleError: error.message }) }).finally(() => { if (current()) this.setData({ articleLoading: false }) })
  },
  reviewNoteInput(e) { if (!this.data.articleSaving) this.setData({ reviewNote: e.detail.value }) },
  decideContentReview(e) {
    if (this.data.articleSaving || !this.data.reviewArticle) return
    const current = this.articleGuard('reviewDecisionRequest', 'content-reviews'), row = this.data.reviewArticle
    this.setData({ articleSaving: true, articleError: '' })
    return api.reviewArticle(row.id, row.version, e.currentTarget.dataset.decision, this.data.reviewNote).then(() => { if (current()) { this.setData({ reviewArticle: null, reviewNote: '' }); return this.loadContentReviews() } })
      .catch(error => { if (current()) this.setData({ articleError: error.message }) }).finally(() => { if (current()) this.setData({ articleSaving: false }) })
  },
  editArticleCategory(e) {
    if (this.data.articleSaving) return
    const entry = this.data.articleCategories.find(row => row.id === e.currentTarget.dataset.id)
    this.setData({ categoryEditor: entry ? { ...entry } : { name: '', version: 0 }, articleError: '' })
  },
  articleCategoryInput(e) { if (!this.data.articleSaving) this.setData({ 'categoryEditor.name': e.detail.value }) },
  cancelArticleCategory() { if (!this.data.articleSaving) this.setData({ categoryEditor: null }) },
  saveArticleCategory() {
    if (!this.data.categoryEditor || this.data.articleSaving) return
    const current = this.articleGuard('articleCategoryRequest', 'articles-admin')
    this.setData({ articleSaving: true, articleError: '' })
    return api.saveArticleCategory(this.data.categoryEditor).then(() => {
      if (current()) { this.setData({ categoryEditor: null }); return this.loadArticles() }
    }).catch(error => { if (current()) this.setData({ articleError: error.message }) })
      .finally(() => { if (current()) this.setData({ articleSaving: false }) })
  }
}
