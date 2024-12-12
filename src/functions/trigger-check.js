import * as core from '@actions/core'
import {COLORS} from './colors'

// A simple function that checks the body of the message against the trigger
// :param body: The content body of the message being checked (String)
// :param trigger: The "trigger" phrase which is searched for in the body of the message
// :returns: true if a message activates the trigger, false otherwise
export async function triggerCheck(body, trigger, param_separator) {
  // Set the output of the comment body for later use with other actions
  core.setOutput('comment_body', body)

  const triggers = trigger.trim().split(/\s+/)
  const startWord = body.split(/\s+/, 1)[0].split(param_separator, 1)[0]
  const command = triggers.find(t => t === startWord)
  // If the trigger is not activated, set the output to false and return with false
  if (!command) {
    core.debug(
      `triggers ${COLORS.highlight}${triggers}${COLORS.reset} not found at comment body start`
    )
    return false
  }

  core.setOutput('command', command)

  return true
}
