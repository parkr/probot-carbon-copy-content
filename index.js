const safeLoad = require('js-yaml').safeLoad

const confFilename = 'carbon-copy.yaml'

// Git Data API use case example
// See: https://developer.github.com/v3/git/ to learn more
module.exports = app => {
  // Opens a PR every time someone installs your app for the first time
  app.on('installation.created', check)
  async function check (context) {
    // shows all repos you've installed the app on
    console.log(context.payload.repositories)

    const owner = context.payload.installation.account.login
    context.payload.repositories.forEach(async (repository) => {
      const repo = repository.name

      // Generates a random number to ensure the git reference isn't already taken
      // NOTE: this is not recommended and just shows an example so it can work :)

      // test
      const branch = `new-branch-${Math.floor(Math.random() * 9999)}`

      // Get current reference in Git
      const reference = await context.github.gitdata.getRef({
        repo, // the repo
        owner, // the owner of the repo
        ref: 'heads/master'
      })
      // Create a branch
      await context.github.gitdata.createRef({
        repo,
        owner,
        ref: `refs/heads/${branch}`,
        sha: reference.data.object.sha // accesses the sha from the heads/master reference we got
      })
      // create a new file
      await context.github.repos.createFile({
        repo,
        owner,
        path: 'path/to/your/file.md', // the path to your config file
        message: 'adds config file', // a commit message
        content: Buffer.from('My new file is awesome!').toString('base64'),
        // the content of your file, must be base64 encoded
        branch // the branch name we used when creating a Git reference
      })
      // create a PR from that branch with the commit of our added file
      await context.github.pullRequests.create({
        repo,
        owner,
        title: 'Adding my file!', // the title of the PR
        head: branch, // the branch our chances are on
        base: 'master', // the branch to which you want to merge your changes
        body: 'Adds my new file!', // the body of your PR,
        maintainer_can_modify: true // allows maintainers to edit your app's PR
      })
    })
  }
  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
  app.on('push', carbonCopyContent)
  async function carbonCopyContent (context) {
    // shows all repos you've installed the app on
    const payload = context.payload
    const repoID = payload.repository.id

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

    const allChangedFiles = getChangedFilesFromPush(payload)
    const conf = await readConfiguration(context, repoID)
    if (conf === undefined) {
      console.log(`no configuration could be found at ${confFilename}`)
      return
    }

    console.log('conf:', conf, 'allChangedFiles:', allChangedFiles)

    allChangedFiles.forEach((path) => {
      const fileConf = conf.files[path]
      if (conf.files[path] !== undefined) {
        console.log(conf[path])
      }
    })

    return

    context.payload.payload.repositories.forEach(async (repository) => {
      const repo = repository.name

      // Generates a random number to ensure the git reference isn't already taken
      // NOTE: this is not recommended and just shows an example so it can work :)

      // test
      const branch = `new-branch-${Math.floor(Math.random() * 9999)}`

      // Get current reference in Git
      const reference = await context.github.gitdata.getRef({
        repo, // the repo
        owner, // the owner of the repo
        ref: 'heads/master'
      })
      // Create a branch
      await context.github.gitdata.createRef({
        repo,
        owner,
        ref: `refs/heads/${branch}`,
        sha: reference.data.object.sha // accesses the sha from the heads/master reference we got
      })
      // create a new file
      await context.github.repos.createFile({
        repo,
        owner,
        path: 'path/to/your/file.md', // the path to your config file
        message: 'adds config file', // a commit message
        content: Buffer.from('My new file is awesome!').toString('base64'),
        // the content of your file, must be base64 encoded
        branch // the branch name we used when creating a Git reference
      })
      // create a PR from that branch with the commit of our added file
      await context.github.pullRequests.create({
        repo,
        owner,
        title: 'Adding my file!', // the title of the PR
        head: branch, // the branch our chances are on
        base: 'master', // the branch to which you want to merge your changes
        body: 'Adds my new file!', // the body of your PR,
        maintainer_can_modify: true // allows maintainers to edit your app's PR
      })
    })
  }

  async function readConfiguration(context, repoID) {
    const rawConf = await readFileFromGitHub(context, repoID, confFilename)
    return safeLoad(rawConf, { filename: confFilename })
  }

  async function readFileFromGitHub(context, repoID, path) {
    // https://developer.github.com/v3/git/
    // Get the current commit object
    const owner = context.payload.repository.owner.login
    const repo = context.payload.repository.name
    const commit_sha = context.payload.after
    const commit = await context.github.gitdata.getCommit({owner, repo, commit_sha})

    // Retrieve the tree it points to
    const tree_sha = commit.data.tree.sha
    const recursive = 1
    const tree = await context.github.gitdata.getTree({owner, repo, tree_sha, recursive})

    // Retrieve the content of the blob object that tree has for that particular file path
    const file = tree.data.tree.filter(file => file.type === 'blob' && file.path === path)[0]
    const file_sha = file.sha
    const blob = await context.github.gitdata.getBlob({owner, repo, file_sha})

    return Buffer.from(blob.data.content, blob.data.encoding).toString()
  }

  function getChangedFilesFromPush(pushPayload) {
    const filenames = []
    pushPayload.commits.forEach((commit) => {
      filenames.push(...commit.added)
      filenames.push(...commit.modified)
    })
    return new Set(filenames)
  }
}
