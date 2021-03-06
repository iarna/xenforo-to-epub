'use strict'
const Site = use('site')
const fs = use('fs-promises')
const moment = require('moment')
const qr = require('@perl/qr')

class Scrivener extends Site {
  static matches (siteUrlStr) {
    return qr`[.]scriv/?`.test(siteUrlStr)
  }

  constructor (siteUrlStr) {
    super(siteUrlStr)
    this.publisher = 'scrivener'
    this.publisherName = 'Scrivener'
    this.shortName = 'scriv'
    this.type = 'scriv'
  }

  normalizeLink (href, base) {
    return href
  }

  getFicMetadata (fetch, fic) {
    const uuid = require('uuid')
    const path = require('path')
    fic.id = 'urn:uuid:' + uuid.v4()
    fic.publisher = this.publisherName
    fic.updateFrom = fic.link.replace(/[/]$/, '')
    fic.link = null
    const basename = path.basename(fic.updateFrom)
    fic.title = basename.replace(/\.scriv$/, '')
    const scrivname = path.join(fic.updateFrom, basename + 'x')
    return this.fromScrivener(fic, scrivname)
  }

  async fromScrivener (fic, scrivx) {
    const fs = use('fs-promises')
    const promisify = use('promisify')
    const parseString = promisify(require('xml2js').parseString)
    const data = await parseString(fs.readFile(scrivx))
    const props = this.scrivMap(data.ScrivenerProject, 'ProjectProperties')
    if (props.ProjectTitle) fic.title = props.ProjectTitle
    if (props.FullName) fic.author = props.FullName
    const items = this.scrivBinder(data.ScrivenerProject, 'Binder')
    return this.recurseItems(fic, items)
  }

  recurseItems (fic, items) {
    const forEach = use('for-each')
    return forEach(items, async item => {
      if (item.Type === 'TrashFolder' || item.Type === 'ResearchFolder') return
      if (item.Children) return this.recurseItems(fic, item.Children)
      const path = require('path')
      const filename = path.join(fic.updateFrom, 'Files', 'Docs', item.ID + '.rtf')
      try {
        await fs.stat(filename)
        fic.addChapter({
          name: item.Title,
          fetchFrom: filename,
          created: moment.unix(item.Created),
          modified: moment.unix(item.Modified),
        })
      } catch (_) {
        process.emit('warn', `Skipping ${item.Title}`)
      }
    })
  }

  scrivValue (obj, prop) {
    return obj[prop] && obj[prop][0]
  }

  scrivMap (obj, prop) {
    const item = this.scrivValue(obj, prop)
    const result = {}
    for (let prop in item) {
      result[prop] = this.scrivValue(item, prop)
    }
    return result
  }

  scrivBinder (obj, prop) {
    const item = this.scrivValue(obj, prop)
    return item.BinderItem.map(item => this.scrivBinderItem(item))
  }

  scrivBinderItem (item) {
    const result = {}
    for (let prop in item['$']) {
      result[prop] = item['$'][prop]
    }
    result.Title = this.scrivValue(item, 'Title')
    result.MetaData = this.scrivMap(item, 'MetaData')
    if (item.Children) {
      result.Children = this.scrivBinder(item, 'Children')
    }
    return result
  }

  async getChapter (fetch, chapter) {
    const fs = use('fs-promises')
    const ChapterContent = use('chapter-content')
    const rtfToHTML = use('rtf-to-html')
    const bbcodeToHTML = use('bbcode-to-html')
    const html = bbcodeToHTML(rtfToHTML(fs.readFile(chapter.fetchWith(), 'ascii')))
    html.on('warning', err => {
      process.emit('warn', 'bbcode', `Error in bbcode ${err.message} in chapter "${chapter.name}"`)
    })
    return new ChapterContent(chapter, {site: this, content: await html.concat()})
  }
}
module.exports = Scrivener
