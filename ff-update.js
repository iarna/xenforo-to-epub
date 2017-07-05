'use strict'
module.exports = update

const Bluebird = require('bluebird')
const qw = require('qw')
const syncTOML = require('@iarna/toml')

const fetch = use('fetch')
const Fic = use('fic')
const ficInflate = use('fic-inflate')
const filenameize = use('filenameize')
const fs = use('fs-promises')
const progress = use('progress')
const promisify = use('promisify')
const TOML = use('toml')

function update (args) {
  const fetchOpts = {
    cacheBreak: !args.cache,
    noNetwork: !args.network,
    maxConcurrency: args.concurrency,
    requestsPerSecond: args['requests-per-second'],
    timeout: 10000
  }
  const fetchAndSpin = fetch.withOpts(fetchOpts).wrapWith(progress.spinWhileAnd)
  if (args.xf_user) fetchAndSpin.setGlobalCookie(`xf_user=${args.xf_user}`)

  return Bluebird.map(args.fic, updateFic(fetchAndSpin, args), {concurrency: 10})
    .reduce((exit, result) => result != null ? result : exit)
    .then(exit => exit > 0 ? 0 : 1) // error if nothing updated
}

function readFic (fic) {
  return fs.readFile(fic).then(toml => Fic.fromJSON(syncTOML.parse(toml)))
}

function updateFic (fetch, args) {
  const addNone = args['add-none']
  const addAll = args['add-all']
  const add = addNone ? 'none' : addAll ? 'all' : 'new'
  let fromThreadmarks = !args.scrape || args['and-fetch']
  let fromScrape = args.scrape || args['and-scrape']
  const refresh = args['refresh']
  let fast = args.fast

  return ficFile => {
    return Bluebird.try(() => {
      const existingFic = readFic(ficFile)
      let newFic = fetchLatestVersionWithoutInflate(fetch, existingFic, fromThreadmarks, fromScrape)
      if (fast) {
        return Bluebird.join(existingFic, newFic, (existingFic, newFic) => {
          const lastExisting = existingFic.chapters.slice(-1)[0] || existingFic
          const lastNew = newFic.chapters.slice(-1)[0] || newFic
          if (lastExisting === lastNew || (lastExisting && lastNew && createdDate(lastExisting) >= createdDate(lastNew))) return
          newFic = ficInflate(newFic, fetch.withOpts({cacheBreak: false}))
          return doMerge()
        })
      } else {
        return doMerge()
      }
      function doMerge () {
        return mergeFic(existingFic, newFic, add).then(changes => {
          const inflatedFic = ficInflate(existingFic, fetch.withOpts({cacheBreak: false}))
          return writeUpdatedFic(ficFile, inflatedFic, refreshMetadata(inflatedFic, changes), refresh)
        })
      }
    }).catch(ex => {
      process.emit('warn', `Skipping ${ficFile}:`, ex)
    })
  }
}

function writeUpdatedFic (ficFile, existingFic, changes, forceSave) {
  return Bluebird.resolve(changes).then(changes => {
    if (!changes.length && !forceSave) return null
    return fs.writeFile(ficFile, TOML.stringify(existingFic)).then(() => {
      progress.output(`${ficFile}\n`)
      if (changes.length) progress.output(`    ${changes.join('\n    ')} \n`)
      return changes.refresh ? 1 : null
    })
  })
}

var fetchLatestVersion = promisify.args((fetch, existingFic, fromThreadmarks, fromScrape) => {
  const newFic = fetchLatestVersionWithoutInflate(fetch, existingFic, fromThreadmarks, fromScrape)

  return ficInflate(newFic, fetch.withOpts({cacheBreak: false}))
})

var fetchLatestVersionWithoutInflate = promisify.args((fetch, existingFic, fromThreadmarks, fromScrape) => {
  const updateFrom = existingFic.updateWith()
  let thisFromThreadmarks = (!existingFic.scrapeMeta && fromThreadmarks) || existingFic.fetchMeta
  let thisFromScrape = fromScrape || existingFic.scrapeMeta

  function getFic (fetch) {
    if (thisFromThreadmarks && thisFromScrape) {
      return Fic.fromUrlAndScrape(fetch, updateFrom)
    } else if (thisFromThreadmarks) {
      return Fic.fromUrl(fetch, updateFrom)
    } else {
      return Fic.scrapeFromUrl(fetch, updateFrom)
    }
  }

  // Fetch the fic from cache first, which ensures we get any cookies
  // associated with it, THEN fetch it w/o the cache to get updates.
  return getFic(fetch.withOpts({cacheBreak: false})).then(()=> getFic(fetch))
})

function createdDate (chapOrFic) {
  return chapOrFic.created || chapOrFic.modified
}

var mergeFic = promisify.args(function mergeFic (existingFic, newFic, add) {
  const changes = []
  const toAdd = []
  const latestExisting = existingFic.chapters.concat(existingFic.fics).map(createdDate).reduce((aa, bb) => {
    return aa > bb ? aa : bb
  }, new Date(0))

  if (add !== 'none') {
    const newestIndex = newFic.chapters.length - 1
    if (newFic.chapters[newestIndex].created || newFic.chapters[newestIndex].modified) {
      for (let newChapter of newFic.chapters) {
        if (existingFic.chapterExists(newChapter.link) || existingFic.chapterExists(newChapter.fetchFrom)) {
          continue
        }
        const created = newChapter.created || newChapter.modified
        if (add === 'all' || createdDate(newChapter) > latestExisting) {
          toAdd.push(newChapter)
        }
      }
    } else {
      for (let ii = newestIndex; ii >= 0; --ii) {
        const newChapter = newFic.chapters[ii]
        if (existingFic.chapterExists(newChapter.link) || existingFic.chapterExists(newChapter.fetchFrom)) {
          if (add === 'all') { continue } else { break }
        }
        toAdd.unshift(newChapter)
      }
    }
  }

  if (existingFic.description == null && newFic.description != null) {
    existingFic.description = newFic.description
    changes.push(`${existingFic.title}: Set fic description to ${newFic.description}`)
  }
  if (existingFic.tags == null && newFic.tags != null && newFic.tags.length) {
    existingFic.tags = newFic.tags
    changes.push(`${existingFic.title}: Set fic tags to ${newFic.tags.join(', ')}`)
  }
  for (let prop of qw`publisher author authorUrl updateFrom link title`) {
    if (existingFic[prop] == null && newFic[prop] != null && (!existingFic.parent || existingFic.parent[prop] !== newFic[prop])) {
      existingFic[prop] = newFic[prop]
      changes.push(`${existingFic.title}: Set fic ${prop} to ${existingFic[prop]}`)
    }
  }

  existingFic.chapters.push.apply(existingFic.chapters, toAdd)
  existingFic.chapters.sort()

  if (toAdd.length) {
    changes.push(`${existingFic.title}: Added ${toAdd.length} new chapters`)
    changes.refresh = true
  }

  const fics = [existingFic].concat(existingFic.fics)
  for (let fic of fics) {
    // Find any chapters with created dates and update them if need be.
    for (let chapter of fic.chapters) {
      const match = newFic.chapters.filter(andChapterEquals(chapter))
      for (let newChapter of match) {
        if (chapter.type === 'chapter' && newChapter.type !== chapter.type) {
          changes.push(`${fic.title}: Updated type for chapter "${newChapter.name}" from ${chapter.type} to ${newChapter.type}`)
          chapter.type = newChapter.type
        }
        if (isDate(newChapter.created) && !dateEqual(newChapter.created, chapter.created)) {
          changes.push(`${fic.title}: Updated creation date for chapter "${newChapter.name}" from ${chapter.created} to ${newChapter.created}`)
          chapter.created = newChapter.created
        }
        if (isDate(newChapter.modified) && !dateEqual(newChapter.modified, chapter.modified)) {
          changes.push(`${fic.title}: Updated modification date for chapter "${newChapter.name}" from ${chapter.modified} to ${newChapter.modified}`)
          chapter.modified = newChapter.modified
        }
        for (let prop of qw`name link fetchFrom author authorUrl tags words`) {
          if (chapter[prop] == null && newChapter[prop] != null) {
            if (newChapter[prop] != fic[prop]) {
              chapter[prop] = newChapter[prop]
              changes.push(`${fic.title}: Set ${prop} for chapter "${newChapter.name}" to ${chapter[prop]}`)
            }
          }
        }
      }
    }
  }
  return changes
})

var refreshMetadata = promisify.args(function mergeFic (existingFic, changes) {
  const fics = [existingFic].concat(existingFic.fics)

  for (let fic of fics) {
    let now = new Date()
    let then = new Date(0)
    let created = fic.chapters.filter(c => c.type === 'chapter' && c.created).reduce((ficCreated, chapter) => ficCreated < chapter.created ? ficCreated : chapter.created, now)
    if (isDate(created) && (created !== now && (!isDate(fic.created) || !dateEqual(created, fic.created)))) {
      changes.push(`${fic.title}: Updated fic publish time from ${fic.created} to ${created} (from earliest chapter)`)
      fic.created = created
    }

    let modified = fic.chapters.filter(c => c.type === 'chapter' && (c.modified || c.created)).reduce((ficModified, chapter) => ficModified > (chapter.modified||chapter.created) ? ficModified : (chapter.modified||chapter.created), then)
    if (isDate(modified) && (modified !== then && (!isDate(fic.modified) || !dateEqual(modified, fic.modified)))) {
      changes.push(`${fic.title}: Updated fic last update time from ${fic.modified} to ${modified} (from latest chapter)`)
      fic.modified = modified
    }
  }
  if (existingFic.chapters.length === 0) {
    let created = existingFic.fics.filter(f => f.created).reduce((ficCreated, subfic) => ficCreated < subfic.created ? ficCreated : subfic.created, existingFic.created)
    if (isDate(created) && (!dateEqual(existingFic.created, created))) {
      changes.push(`${existingFic.title}: Updated fic publish time from ${existingFic.created} to ${created} (from earliest subfic)`)
      existingFic.created = created
    }
    let modified = existingFic.fics.filter(f => f.modified || f.created).reduce((ficModified, subfic) => ficModified > (subfic.modified||subfic.created) ? ficModified : (subfic.modified||subfic.created), existingFic.modified)
    if (isDate(modified) && (!dateEqual(existingFic.modified, modified))) {
      changes.push(`${existingFic.title}: Updated fic last update time from ${existingFic.modified} to ${modified} (from latest subfic)`)
      existingFic.modified = modified
    }
  }
  return changes
})

function andChapterEquals (chapterA) {
  return chapterB => chapterEqual(chapterA, chapterB)
}

function chapterEqual (chapterA, chapterB) {
  return (chapterA.link && chapterB.link && chapterA.link === chapterB.link) ||
         (chapterA.fetchFrom && chapterB.fetchFrom && chapterA.fetchFrom === chapterB.fetchFrom)
}

function dateEqual (dateA, dateB) {
  const dateAStr = isDate(dateA) && dateA.toISOString && dateA.toISOString()
  const dateBStr = isDate(dateB) && dateB.toISOString && dateB.toISOString()
  return dateAStr === dateBStr
}

function isDate (date) {
  if (date == null) return false
  if (isNaN(date)) return false
  return date instanceof Date
}
