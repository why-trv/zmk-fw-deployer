const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const readline = require('node:readline');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
require('dotenv').config();

const GITHUB_ACTIONS_POLLING_INTERVAL = 10000; // ms
const FW_VOLUME_NAME = 'nicenano';

const args = process.argv.slice(2);
const WATCH_MODE = args.includes('--watch');

const TMP_DIR = path.join(__dirname, 'tmp');

// Ensure tmp directory exists
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Platform-specific drive paths
const DRIVE_PATHS = {
  linux: () => `/media/${process.env.USER}`,
  darwin: () => '/Volumes'
};

const execFilePromise = promisify(execFile);

// Add constants for ANSI formatting
const ANSI = {
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  GREEN: '\x1b[32m',
  BLUE: '\x1b[94m',  // Light blue
  MAGENTA: '\x1b[95m',  // Light magenta
  RESET: '\x1b[0m'
};

function capitalizeFirstLetter(val) {
    return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}

function parseGitHubUrl(url) {
  try {
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
      throw new Error('Invalid GitHub URL format');
    }
    return {
      owner: match[1],
      repo: match[2].replace('.git', '')
    };
  } catch (error) {
    throw new Error('Could not parse GitHub URL');
  }
}

function getGitHubCredentials() {
  const { GITHUB_REPO_URL, GITHUB_TOKEN } = process.env;
  
  if (!GITHUB_REPO_URL) {
    throw new Error('GITHUB_REPO_URL is not set in .env file');
  }
  if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not set in .env file');
  }

  const { owner, repo } = parseGitHubUrl(GITHUB_REPO_URL);
  return { owner, repo, token: GITHUB_TOKEN };
}

async function getWorkflowRun(runId, owner, repo, token) {
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${owner}/${repo}/actions/runs/${runId}`,
    headers: {
      'User-Agent': 'Node.js',
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  };

  return new Promise((resolve, reject) => {
    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const run = JSON.parse(data);
        resolve(run);
      });
    }).on('error', reject);
  });
}

function formatCommitInfo(sha, branch, message) {
  return `${ANSI.BOLD}${sha}${ANSI.RESET} (${ANSI.GREEN}${branch}${ANSI.RESET}) "${ANSI.DIM}${message}${ANSI.RESET}"`;
}

async function getLatestArtifact(owner, repo, token) {
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${owner}/${repo}/actions/artifacts`,
    headers: {
      'User-Agent': 'Node.js',
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  };

  return new Promise((resolve, reject) => {
    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', async () => {
        const artifacts = JSON.parse(data);
        if (artifacts.artifacts && artifacts.artifacts.length > 0) {
          const artifact = artifacts.artifacts[0];
          const run = await getWorkflowRun(artifact.workflow_run.id, owner, repo, token);
          
          // Check if the workflow run is completed
          if (run.status !== 'completed' || run.conclusion !== 'success') {
            reject(new Error('Latest workflow run is not completed successfully'));
            return;
          }

          resolve({ 
            ...artifact, 
            commit: {
              sha: run.head_sha.slice(0, 7),
              branch: run.head_branch,
              message: run.head_commit.message
            }
          });
        } else {
          reject(new Error('No artifacts found'));
        }
      });
    }).on('error', reject);
  });
}

async function downloadArtifact(artifact, owner, repo, token) {
  // First request to get the redirect URL
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${owner}/${repo}/actions/artifacts/${artifact.id}/zip`,
    headers: {
      'User-Agent': 'Node.js',
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  };

  return new Promise((resolve, reject) => {
    https.get(options, (res) => {
      if (res.statusCode === 302) {
        // Follow the redirect
        https.get(res.headers.location, (downloadRes) => {
          const zipPath = path.join(TMP_DIR, 'firmware.zip');
          const fileStream = fs.createWriteStream(zipPath);
          downloadRes.pipe(fileStream);
          fileStream.on('finish', () => resolve(zipPath));
          fileStream.on('error', reject);
        }).on('error', reject);
      } else {
        reject(new Error(`Failed to get download URL: ${res.statusCode}`));
      }
    }).on('error', reject);
  });
}

class Spinner {
  constructor(message) {
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.message = message;
    this.currentFrame = 0;
    this.interval = null;
    this.isSpinning = false;
  }

  start() {
    this.isSpinning = true;
    this.interval = setInterval(() => {
      process.stdout.write(`\r${this.frames[this.currentFrame]} ${this.message}`);
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    }, 80);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      process.stdout.write('\n');
      process.stdout.write('\r' + ' '.repeat(this.message.length + 2) + '\r');
      this.isSpinning = false;
    }
  }
}

function formatSide(side) {
  return `${ANSI.BOLD}${side.toLowerCase() === 'left' ? ANSI.BLUE : ANSI.MAGENTA}${side}${ANSI.RESET}`;
}

async function waitForDrive(side, requireFresh = false) {
  console.log('');
  const spinner = new Spinner(`Waiting for bootloader volume, ${ANSI.BOLD}double-click the reset button on the ${formatSide(side)}${ANSI.BOLD} part of your keyboard...${ANSI.RESET}`);
  
  try {
    // If we require a fresh mount, wait for drive to be absent first
    if (requireFresh) {
      while (true) {
        const drive = await findMountedDrive();
        if (!drive) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    spinner.start();
    while (true) {
      const drive = await findMountedDrive();
      if (drive) {
        spinner.stop();
        console.log(`Found ${formatSide(side)} side keyboard at ${drive}`);
        return drive;
      }
      // Wait 1 second before checking again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    spinner.stop();
    throw error;
  }
}

async function findMountedDrive() {
  const platform = os.platform();
  const drivePath = DRIVE_PATHS[platform];
  
  if (!drivePath) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  try {
    const drives = fs.readdirSync(drivePath());
    const niceBoot = drives.find(drive => drive.toLowerCase().includes(FW_VOLUME_NAME));
    if (niceBoot) {
      return path.join(drivePath(), niceBoot);
    }
    return null;
  } catch (error) {
    console.error(`Error accessing drives: ${error.message}`);
    return null;
  }
}

async function findFirmwareFile(side, directory) {
  try {
    const files = fs.readdirSync(directory);
    const firmwareFile = files.find(file => 
      file.toLowerCase().includes(side) && file.endsWith('.uf2')
    );
    if (!firmwareFile) {
      throw new Error(`Could not find ${side} firmware file`);
    }
    return firmwareFile;
  } catch (error) {
    throw new Error(`Error finding ${side} firmware: ${error.message}`);
  }
}

async function copyFirmware(side, drivePath) {
  const firmwareFile = await findFirmwareFile(side, TMP_DIR);
  const firmwarePath = path.join(TMP_DIR, firmwareFile);
  const targetPath = path.join(drivePath, firmwareFile);
  
  const attemptCopy = () => {
    try {
      fs.copyFileSync(firmwarePath, targetPath);
      console.log(`${formatSide(capitalizeFirstLetter(side))} side firmware deployed!`);
      return firmwareFile;
    } catch (error) {
      if (error.code === 'EIO') {
        console.log(`${formatSide(capitalizeFirstLetter(side))} side firmware likely deployed successfully (drive disconnected during copy)`);
        return firmwareFile;
      }
      throw error;
    }
  };

  try {
    return attemptCopy();
  } catch (error) {
    if (error.code === 'EACCES') {
      console.log(`Permission denied, retrying ${formatSide(side)} side deployment...`);
      // Small delay before retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      return attemptCopy();
    }
    throw new Error(`Failed to copy firmware to ${formatSide(side)} side: ${error.message}`);
  }
}

async function extractZip(zipPath, targetDir) {
  try {    
    await execFilePromise('unzip', ['-o', zipPath, '-d', targetDir]);
  } catch (error) {    
    throw new Error(`Failed to extract firmware: ${error.message}`);
  }
}

async function deployFirmware(existingArtifact = null) {
  try {
    const { owner, repo, token } = getGitHubCredentials();
    
    let artifact = existingArtifact;
    if (!artifact) {
      console.log('Fetching latest firmware artifact...');
      artifact = await getLatestArtifact(owner, repo, token);
    }
    console.log(`Found firmware from commit ${formatCommitInfo(artifact.commit.sha, artifact.commit.branch, artifact.commit.message)}`);
    
    console.log('Downloading firmware...');
    const zipPath = await downloadArtifact(artifact, owner, repo, token);
    
    console.log('Extracting firmware...');
    await extractZip(zipPath, TMP_DIR);

    let leftFirmware, rightFirmware;

    if (await findMountedDrive()) {
      console.warn(`Found an already mounted drive - assuming this is the ${formatSide('left')} side`);
    }

    // Deploy left side (can be already mounted)
    const leftDrive = await waitForDrive('left');
    leftFirmware = await copyFirmware('left', leftDrive);

    // Deploy right side (must be freshly mounted)
    const rightDrive = await waitForDrive('right', true);
    rightFirmware = await copyFirmware('right', rightDrive);

    // Cleanup
    fs.unlinkSync(zipPath);
    fs.unlinkSync(path.join(TMP_DIR, leftFirmware));
    fs.unlinkSync(path.join(TMP_DIR, rightFirmware));
    
    console.log(`\n${ANSI.BOLD}${ANSI.GREEN}Deployment complete!${ANSI.RESET}`);
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    rl.close();
  }
}

async function getLatestWorkflowRun(owner, repo, token) {
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${owner}/${repo}/actions/runs?status=in_progress`,
    headers: {
      'User-Agent': 'Node.js',
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  };

  return new Promise((resolve, reject) => {
    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const response = JSON.parse(data);
        if (response.workflow_runs && response.workflow_runs.length > 0) {
          resolve(response.workflow_runs[0]);
        } else {
          resolve(null);
        }
      });
    }).on('error', reject);
  });
}

async function checkForNewFirmware(owner, repo, token, startTime, lastReportedWorkflowId) {
  // First check if there's a build in progress
  const runningWorkflow = await getLatestWorkflowRun(owner, repo, token);
  if (runningWorkflow) {
    const workflowStarted = new Date(runningWorkflow.created_at);
    if (workflowStarted > startTime && runningWorkflow.id !== lastReportedWorkflowId) {
      console.log(`Build in progress for commit ${formatCommitInfo(
        runningWorkflow.head_sha.slice(0, 7),
        runningWorkflow.head_branch,
        runningWorkflow.head_commit.message
      )}`);
      return { type: 'in_progress', workflow: runningWorkflow };
    }
  }

  // Then check for completed artifacts
  const artifact = await getLatestArtifact(owner, repo, token);
  const artifactCreated = new Date(artifact.created_at);
  
  if (artifactCreated > startTime) {
    return { type: 'completed', artifact };
  }
  
  return null;
}

function formatGitHubUrl(owner, repo) {
  return `${ANSI.DIM}https://github.com/${owner}/${repo}${ANSI.RESET}`;
}

async function watchAndDeploy() {
  try {
    const { owner, repo, token } = getGitHubCredentials();
    let lastArtifactId = null;
    let lastReportedWorkflowId = null;
    let isBusy = false;
    const startTime = new Date();
    
    console.log(`Watching for new firmware builds from ${formatGitHubUrl(owner, repo)}...`);
    
    const interval = setInterval(async () => {
      if (isBusy) return;

      try {
        const result = await checkForNewFirmware(owner, repo, token, startTime, lastReportedWorkflowId);
        
        if (result) {
          if (result.type === 'in_progress') {
            lastReportedWorkflowId = result.workflow.id;
          } else if (result.type === 'completed' && lastArtifactId !== result.artifact.id) {
            console.log(`New firmware build detected from commit ${formatCommitInfo(
              result.artifact.commit.sha,
              result.artifact.commit.branch,
              result.artifact.commit.message
            )}`);
            lastArtifactId = result.artifact.id;
            
            isBusy = true;
            await deployFirmware(result.artifact);
            isBusy = false;
            
            console.log(`\nWatching for new firmware builds from ${formatGitHubUrl(owner, repo)}...`);
          }
        }
      } catch (error) {
        console.error('Error checking for updates:', error.message);
      }
    }, GITHUB_ACTIONS_POLLING_INTERVAL);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      clearInterval(interval);
      rl.close();
      console.log('\nStopped watching for firmware builds');
      process.exit(0);
    });

  } catch (error) {
    console.error('Error:', error.message);
    rl.close();
  }
}

// Choose mode based on flag
if (WATCH_MODE) {
  watchAndDeploy();
} else {
  deployFirmware();
} 