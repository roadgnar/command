import * as core from '@actions/core'
import {validPermissions} from './valid-permissions'
import {isAllowed} from './allowlist'
import {COLORS} from './colors'

// Runs precheck logic before the IssueOps command can proceed
// :param issue_number: The issue number of the event (String)
// :param allowForks: Boolean which defines whether the Action can run from forks or not
// :param skipCi: Boolean which defines whether CI checks should be skipped or not
// :param skipReviews: Boolean which defines whether PR reviews should be skipped or not
// :param allowDraftPRs: Boolean which defines whether draft PRs should be allowed or not
// :param contextType: The type of context (issue or pull_request)
// :param context: The context of the event
// :param octokit: The octokit client
// :returns: An object that contains the results of the prechecks, message, ref, and status
export async function prechecks(
  issue_number,
  allowForks,
  skipCi,
  skipReviews,
  allowDraftPRs,
  contextType,
  context,
  octokit
) {
  // Setup the message variable
  var message

  // Check if the user has valid permissions
  const validPermissionsRes = await validPermissions(octokit, context)
  if (validPermissionsRes !== true) {
    return {message: validPermissionsRes, status: false}
  }

  // Get allowed operator data
  if (!(await isAllowed(context))) {
    message = `### ⚠️ Cannot proceed with operation\n\n> User ${context.actor} is not an allowed operator`
    return {message: message, status: false}
  }

  // if this is an issue comment, we can skip all the logic below here as it...
  // ... only applies to pull requests
  if (contextType === 'issue') {
    message = `✅ operation requested on an ${COLORS.highlight}issue`
    core.info(message)
    return {message: message, status: true, ref: null, sha: null}
  }

  // Get the PR data
  const pr = await octokit.rest.pulls.get({
    ...context.repo,
    pull_number: context.issue.number
  })
  if (pr.status !== 200) {
    message = `Could not retrieve PR info: ${pr.status}`
    return {message: message, status: false}
  }

  // save sha and ref
  var sha = pr.data.head.sha
  var ref = pr.data.head.ref

  var forkBypass = false

  // Determine whether to use the ref or sha depending on if the PR is from a fork or not
  // Note: We should not export fork values if the stable_branch is being used here
  if (pr.data.head.repo?.fork === true && forkBypass === false) {
    core.info(`🍴 the pull request is a ${COLORS.highlight}fork`)
    core.setOutput('fork', 'true')

    // If this Action's inputs have been configured to explicitly prevent forks, exit
    if (allowForks === false) {
      message = `### ⚠️ Cannot proceed with operation\n\nThis Action has been explicity configured to prevent operations from forks. You can change this via this Action's inputs if needed`
      return {message: message, status: false}
    }

    // Set some outputs specific to forks
    const label = pr.data.head.label
    const forkRef = pr.data.head.ref
    const forkCheckout = `${label.replace(':', '-')} ${forkRef}`
    const forkFullName = pr.data.head.repo.full_name
    core.setOutput('fork_ref', forkRef)
    core.setOutput('fork_label', label)
    core.setOutput('fork_checkout', forkCheckout)
    core.setOutput('fork_full_name', forkFullName)
    core.debug(`fork_ref: ${forkRef}`)
    core.debug(`fork_label: ${label}`)
    core.debug(`fork_checkout: ${forkCheckout}`)
    core.debug(`fork_full_name: ${forkFullName}`)

    // If this pull request is a fork, use the exact SHA rather than the branch name
    ref = pr.data.head.sha
  } else {
    // If this PR is NOT a fork, we can safely use the branch name
    core.setOutput('fork', 'false')
  }

  // Check to ensure PR CI checks are passing and the PR has been reviewed
  // mergeStateStatus is in the query below but not used at this time
  const query = `query($owner:String!, $name:String!, $number:Int!) {
                    repository(owner:$owner, name:$name) {
                        pullRequest(number:$number) {
                            reviewDecision
                            commits(last: 1) {
                                nodes {
                                    commit {
                                        checkSuites {
                                          totalCount
                                        }
                                        statusCheckRollup {
                                            state
                                        }
                                    }
                                }
                            }
                        }
                    }
                }`
  // Note: https://docs.github.com/en/graphql/overview/schema-previews#merge-info-preview (mergeStateStatus)
  const variables = {
    owner: context.repo.owner,
    name: context.repo.repo,
    number: parseInt(issue_number),
    headers: {
      Accept: 'application/vnd.github.merge-info-preview+json'
    }
  }
  // Make the GraphQL query
  const result = await octokit.graphql(query, variables)

  // Check the reviewDecision
  var reviewDecision
  if (skipReviews) {
    // If skipReviews is true, we bypass the results the graphql
    reviewDecision = 'skip_reviews'
  } else {
    // Otherwise, grab the reviewDecision from the GraphQL result
    reviewDecision = result.repository.pullRequest.reviewDecision
  }

  // Grab the draft status
  const isDraft = pr.data.draft

  // log some extra details if the state of the PR is in a 'draft'
  if (isDraft && !allowDraftPRs) {
    core.warning(
      `operation requested on a draft PR when draft PRs are not allowed`
    )
  } else if (isDraft && allowDraftPRs) {
    core.info(
      `📓 operation requested on a ${COLORS.highlight}draft${COLORS.reset} pull request`
    )
  }

  // Grab the statusCheckRollup state from the GraphQL result
  var commitStatus
  try {
    // Check to see if skipCi is set
    if (skipCi) {
      core.info(
        `✅ CI checks have been ${COLORS.highlight}disabled${COLORS.reset} for this operation`
      )
      commitStatus = 'skip_ci'
    }

    // If there are no CI checks defined at all, we can set the commitStatus to null
    else if (
      result.repository.pullRequest.commits.nodes[0].commit.checkSuites
        .totalCount === 0
    ) {
      core.info('💡 no CI checks have been defined for this pull request')
      commitStatus = null

      // If there are CI checked defined, we need to check for the 'state' of the latest commit
    } else {
      commitStatus =
        result.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup
          .state
    }
  } catch (e) {
    core.debug(`could not retrieve PR commit status: ${e} - Handled: OK`)
    core.debug('this repo may not have any CI checks defined')
    core.debug('skipping commit status check and proceeding...')
    commitStatus = null

    // Try to display the raw GraphQL result for debugging purposes
    try {
      core.debug('raw graphql result for debugging:')
      core.debug(result)
    } catch {
      // istanbul ignore next
      core.debug(
        'Could not output raw graphql result for debugging - This is bad'
      )
    }
  }

  // log values for debugging
  core.debug('precheck values for debugging:')
  core.debug(`reviewDecision: ${reviewDecision}`)
  core.debug(`commitStatus: ${commitStatus}`)
  core.debug(`skipCi: ${skipCi}`)
  core.debug(`skipReviews: ${skipReviews}`)
  core.debug(`allowForks: ${allowForks}`)
  core.debug(`forkBypass: ${forkBypass}`)

  if (isDraft && !allowDraftPRs) {
    message = `### ⚠️ Cannot proceed with operation\n\n> Your pull request is in a draft state`
    return {message: message, status: false}

    // If everything is OK, print a nice message
  } else if (reviewDecision === 'APPROVED' && commitStatus === 'SUCCESS') {
    message = '✅ PR is approved and all CI checks passed'
    core.info(message)

    // CI checks have not been defined AND required reviewers have not been defined
  } else if (reviewDecision === null && commitStatus === null) {
    message =
      '🎛️ CI checks have not been defined and required reviewers have not been defined'
    core.info(message)

    // CI checks are passing and the reviewers is undefined
  } else if (reviewDecision === null && commitStatus === 'SUCCESS') {
    message = '✅ CI checks are passing and reviews are not defined'
    core.info(message)

    // CI checks are passing and reviews are set to be bypassed
  } else if (commitStatus === 'SUCCESS' && reviewDecision == 'skip_reviews') {
    message =
      '✅ CI checks are passing and reviews have been disabled for this operation'
    core.info(message)

    // CI checks are set to be bypassed and the pull request is approved
  } else if (commitStatus === 'skip_ci' && reviewDecision === 'APPROVED') {
    message =
      '✅ CI requirements have been disabled for this operation and the PR has been approved'
    core.info(message)

    // CI checks are set to be bypassed and reviews are undefined
  } else if (commitStatus === 'skip_ci' && reviewDecision === null) {
    message =
      '✅ CI requirements have been disabled for this operation and reviews are not required'
    core.info(message)

    // CI checks are set to be bypassed and the PR has not been reviewed
  } else if (
    commitStatus === 'skip_ci' &&
    reviewDecision === 'REVIEW_REQUIRED'
  ) {
    message = `### ⚠️ Cannot proceed with operation\n\n> CI checks are not required for this operation but the PR has not been reviewed`
    return {message: message, status: false}

    // If CI checks are set to be bypassed and PR reviews are also set to by bypassed
  } else if (commitStatus === 'skip_ci' && reviewDecision === 'skip_reviews') {
    message = '✅ CI and PR reviewers are not required for this operation'
    core.info(message)

    // If CI is passing but the PR has not been reviewed
  } else if (
    reviewDecision === 'REVIEW_REQUIRED' &&
    commitStatus === 'SUCCESS'
  ) {
    message = `### ⚠️ Cannot proceed with operation\n\n> CI checks are passing but the PR has not been reviewed`
    return {message: message, status: false}

    // If CI has not been defined but the PR has been approved
  } else if (commitStatus === null && reviewDecision === 'APPROVED') {
    message = '✅ CI checks have not been defined but the PR has been approved'
    core.info(message)

    // If CI is pending and the PR has not been reviewed
  } else if (
    reviewDecision === 'REVIEW_REQUIRED' &&
    commitStatus === 'PENDING'
  ) {
    message = `### ⚠️ Cannot proceed with operation\n\n- reviewDecision: \`${reviewDecision}\`\n- commitStatus: \`${commitStatus}\`\n\n> CI is still in a pending state and reviews are also required for this operation`
    return {message: message, status: false}

    // If CI is pending and reviewers have not been defined
  } else if (reviewDecision === null && commitStatus === 'PENDING') {
    message = `### ⚠️ Cannot proceed with operation\n\n- reviewDecision: \`${reviewDecision}\`\n- commitStatus: \`${commitStatus}\`\n\n> CI checks must be passing in order to continue`
    return {message: message, status: false}

    // If CI is undefined and the PR has not been reviewed
  } else if (reviewDecision === 'REVIEW_REQUIRED' && commitStatus === null) {
    message = `### ⚠️ Cannot proceed with operation\n\n- reviewDecision: \`${reviewDecision}\`\n- commitStatus: \`${commitStatus}\`\n\n> CI checks have not been defined but reviews are required for this operation`
    return {message: message, status: false}

    // If CI checks are pending and the PR has not been reviewed
  } else if (
    (reviewDecision === 'APPROVED' ||
      reviewDecision === null ||
      reviewDecision === 'skip_reviews') &&
    commitStatus === 'PENDING'
  ) {
    message = `### ⚠️ Cannot proceed with operation\n\n- reviewDecision: \`${reviewDecision}\`\n- commitStatus: \`${commitStatus}\`\n\n> Reviews are not required for this operation but CI checks must be passing in order to continue`
    return {message: message, status: false}

    // If CI is passing but the PR is missing an approval, let the user know
  } else if (reviewDecision === 'APPROVED' && commitStatus === 'FAILURE') {
    message = `### ⚠️ Cannot proceed with operation\n\n- reviewDecision: \`${reviewDecision}\`\n- commitStatus: \`${commitStatus}\`\n\n> Your pull request is approved but CI checks are failing`
    return {message: message, status: false}

    // If the PR does not require approval but CI is failing
  } else if (
    (reviewDecision === null || reviewDecision === 'skip_reviews') &&
    commitStatus === 'FAILURE'
  ) {
    message = `### ⚠️ Cannot proceed with operation\n\n- reviewDecision: \`${reviewDecision}\`\n- commitStatus: \`${commitStatus}\`\n\n> Reviews are not required for this operation but CI checks must be passing in order to continue`
    return {message: message, status: false}
  }

  // Return a success message
  return {
    message: message,
    status: true,
    ref: ref,
    sha: sha
  }
}
