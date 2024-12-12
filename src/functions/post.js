import * as core from '@actions/core'
import {contextCheck} from './context-check'
import * as github from '@actions/github'
import {context} from '@actions/github'
import {postReactions} from './post-reactions'
import {octokitRetry} from '@octokit/plugin-retry'

// Default failure reaction
const thumbsDown = '-1'
// Default success reaction
const thumbsUp = '+1'

export async function post() {
  try {
    const reaction_id = core.getState('reaction_id')
    const token = core.getState('actionsToken')
    const bypass = core.getState('bypass')
    const status = core.getInput('status')
    const skip_completing = core.getBooleanInput('skip_completing')

    // If bypass is set, exit the workflow
    if (bypass === 'true') {
      core.warning('bypass set, exiting')
      return
    }

    // Check the context of the event to ensure it is valid, return if it is not
    const contextCheckResults = await contextCheck(context)
    if (!contextCheckResults.valid) {
      return
    }

    // if skip_completing is set, return
    if (skip_completing) {
      core.info('⏩ skip_completing set, exiting')
      return
    }

    // Create an octokit client with the retry plugin
    const octokit = github.getOctokit(token, {
      additionalPlugins: [octokitRetry]
    })

    // Check the Action status
    var success
    if (status === 'success') {
      success = true
    } else {
      success = false
    }

    // Select the reaction to add to the issue_comment
    // If it is a success, use the user defined reaction
    // Otherwise, add a thumbs down reaction
    var reaction
    if (success) {
      reaction = core.getInput('reaction') || thumbsUp
    } else {
      reaction = thumbsDown
    }

    // Update the reactions on the command comment
    await postReactions(octokit, context, reaction, reaction_id)

    return
  } catch (error) {
    core.error(error.stack)
    core.setFailed(error.message)
  }
}
