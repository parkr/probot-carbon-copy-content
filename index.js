const safeLoad = require('js-yaml').safeLoad
const Buffer = require('buffer').Buffer

const goldenMasterRepoName = 'carbon-copy-content'
const confFilename = 'carbon-copy.yaml'

// For more information on building apps:
// https://probot.github.io/docs/

// To get your app running against GitHub, see:
// https://probot.github.io/docs/development/
module.exports = app => {
  app.on('push', carbonCopyContent)
  async function carbonCopyContent (context) {
    // shows all repos you've installed the app on
    const payload = context.payload

    if (payload.repository.name !== 'carbon-copy-content') {
      console.log(`received push event for ${payload.repository.full_name}, ignoring`)
      return
    }

    if (payload.ref !== 'refs/heads/master') {
      return
    }

    // A push event has been triggered on the repo containing the "golden master" content.
    // Copy this content to all its configured repos.
    // If the configuration file was changed, re-run the entire file.
    // Otherwise, filter to just the files which were changed.

    const conf = await readConfiguration(context)
    if (conf === undefined) {
      console.log(`no configuration could be found at ${confFilename}`)
      return
    }

    const changedFilesInPush = getChangedFilesFromPush(payload)
    let filesToUpdate
    if (changedFilesInPush.has(confFilename)) {
      console.log('the conf file changed, so we are doing EVERYTHING in the conf')
      filesToUpdate = conf.files.keys()
    } else {
      filesToUpdate = [...changedFilesInPush].filter(path => conf.files[path] !== undefined)
    }

    const updates = filesToUpdate.
      map(path => updateFile(context, conf, path))

    await Promise.all(updates)
  }

  async function readConfiguration(context) {
    const rawConf = await readFileFromGitHub(context, goldenMasterRepoName, confFilename)
    return safeLoad(rawConf, { filename: confFilename })
  }

  async function readFileFromGitHub(context, repo, path) {
    const data = await readBlobFromGitHub(context, repo, path)
    if (data === undefined || data.blob === undefined) {
      console.log(`${repo}: ${path} - not found`)
      return
    }
    return Buffer.from(data.blob.content, data.blob.encoding).toString()
  }

  async function readBlobFromGitHub(context, repo, path) {
    const owner = context.payload.repository.owner.login

    // This is the value that is returned.
    const data = {
      ref: undefined,
      commit: undefined,
      tree: undefined,
      blob: undefined
    }

    // https://developer.github.com/v3/git/
    // Get the ref
    const ref = await context.github.gitdata.getRef({owner, repo, ref: `heads/master`})
    data.ref = ref.data // fill in our return value

    // Get the current commit object
    const commit_sha = ref.data.object.sha
    const commit = await context.github.gitdata.getCommit({owner, repo, commit_sha})
    data.commit = commit.data // fill in our return value

    // Retrieve the tree it points to
    const tree_sha = commit.data.tree.sha
    const recursive = 1
    const tree = await context.github.gitdata.getTree({owner, repo, tree_sha, recursive})
    data.tree = tree.data // fill in our return value

    // Retrieve the content of the blob object that tree has for that particular file path
    const file = tree.data.tree.filter(file => file.type === 'blob' && file.path === path)[0]
    if (file === undefined) {
      return data
    }
    const file_sha = file.sha
    const blob = await context.github.gitdata.getBlob({owner, repo, file_sha})
    data.blob = blob.data // fill in our return value

    return data
  }

  function getChangedFilesFromPush(pushPayload) {
    const filenames = []
    pushPayload.commits.forEach((commit) => {
      filenames.push(...commit.added)
      filenames.push(...commit.modified)
    })
    return new Set(filenames)
  }

  async function updateFile(context, conf, path) {
    const masterFileContents = await readFileFromGitHub(context, goldenMasterRepoName, path)

    if (masterFileContents === undefined) {
      console.log(`${context.payload.repository.owner.login}: ${path} - no golden master content`)
      return
    }

    const promises = conf.files[path].destination_repos.map(repoNWO => updateFileInRepo(context, conf, path, masterFileContents, repoNWO))
    return promises
  }

  async function updateFileInRepo(context, conf, path, masterFileContents, repoNWO) {
    const [owner, repo] = repoNWO.split('/')

    console.log(`${owner}/${repo}: ${path} - fetching`)
    let currentFileContents
    try {
      currentFileContents = await readFileFromGitHub(context, repo, path)
    } catch(e) {
      if (e.code !== 404) {
        throw e
      }
    }

    // We have nothing to do here. Neat.
    if (currentFileContents === masterFileContents) {
      console.log(`${owner}/${repo}: ${path} - up to date`)
      return
    }

    console.log(`${owner}/${repo}: ${path} - needs updating`)

    const currBlobData = await readBlobFromGitHub(context, repo, path)

    const newBlob = await context.github.gitdata.createBlob({owner, repo,
      content: Buffer.from(masterFileContents).toString('base64'),
      encoding: 'base64'
    })

    const currBlobTreeData = currBlobData.tree.tree.map((obj) => {
      if (obj.path == path) {
        return {
          path: obj.path,
          mode: obj.mode,
          type: obj.type,
          sha: newBlob.data.sha,
        }
      } else {
        return {
          path: obj.path,
          mode: obj.mode,
          type: obj.type,
          sha: obj.sha,
        }
      }
    })
    const newTree = await context.github.gitdata.createTree({owner, repo,
      tree: currBlobTreeData,
      base_sha: currBlobData.tree.sha,
    })

    const branch = `probot-carbon-copy-content`
    let parentCommit
    try {
      const branchRef = await context.github.gitdata.getRef({owner, repo, ref: `heads/${branch}`})
      parentCommit = branchRef.data.object.sha
    } catch (e) {
      parentCommit = currBlobData.commit.sha
    }
    const newCommit = await context.github.gitdata.createCommit({owner, repo,
      message: `Automatic update of ${path} from ${owner}/${goldenMasterRepoName}`,
      tree: newTree.data.sha,
      parents: [parentCommit],
    })

    await context.github.gitdata.createRef({owner, repo,
      ref: `refs/heads/${branch}`,
      sha: newCommit.data.sha,
    })

    const pullRequest = await context.github.pullRequests.create({owner, repo,
      title: 'Updating stock files', // the title of the PR
      head: branch,
      base: 'master',
      maintainer_can_modify: true,
      body: `Hey! A change was made to the template files which are cloned to other repositories.`,
    })
    console.log('New pull request:', pullRequest.data.html_url)
  }
}
