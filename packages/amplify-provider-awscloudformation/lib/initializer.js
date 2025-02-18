const moment = require('moment');
const path = require('path');
const archiver = require('../src/utils/archiver');
const fs = require('fs-extra');
const ora = require('ora');
const sequential = require('promise-sequential');
const Cloudformation = require('../src/aws-utils/aws-cfn');
const S3 = require('../src/aws-utils/aws-s3');
const constants = require('./constants');
const configurationManager = require('./configuration-manager');
const amplifyServiceManager = require('./amplify-service-manager');

async function run(context) {
  await configurationManager.init(context);
  if (!context.exeInfo || context.exeInfo.isNewEnv) {
    context.exeInfo = context.exeInfo || {};
    const { projectName } = context.exeInfo.projectConfig;
    const initTemplateFilePath = path.join(__dirname, 'rootStackTemplate.json');
    const timeStamp = `${moment().format('Hmmss')}`;
    const { envName = '' } = context.exeInfo.localEnvInfo;
    let stackName = normalizeStackName(`amplify-${projectName}-${envName}-${timeStamp}`);
    const awsConfig = await configurationManager.getAwsConfig(context);

    const amplifyServiceParams = {
      context,
      awsConfig,
      projectName,
      envName,
      stackName,
    };
    const { amplifyAppId, verifiedStackName, deploymentBucketName } = await amplifyServiceManager.init(amplifyServiceParams);

    stackName = verifiedStackName;
    const authRoleName = `${stackName}-authRole`;
    const unauthRoleName = `${stackName}-unauthRole`;
    const params = {
      StackName: stackName,
      Capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
      TemplateBody: fs.readFileSync(initTemplateFilePath).toString(),
      Parameters: [
        {
          ParameterKey: 'DeploymentBucketName',
          ParameterValue: deploymentBucketName,
        },
        {
          ParameterKey: 'AuthRoleName',
          ParameterValue: authRoleName,
        },
        {
          ParameterKey: 'UnauthRoleName',
          ParameterValue: unauthRoleName,
        },
      ],
    };

    const spinner = ora();
    spinner.start('Initializing project in the cloud...');
    return new Cloudformation(context, 'init', awsConfig)
      .then(cfnItem => cfnItem.createResourceStack(params))
      .then(stackDescriptionData => {
        processStackCreationData(context, amplifyAppId, stackDescriptionData);
        spinner.succeed('Successfully created initial AWS cloud resources for deployments.');
        return context;
      })
      .catch(e => {
        spinner.fail('Root stack creation failed');
        throw e;
      });
  }
}

function processStackCreationData(context, amplifyAppId, stackDescriptiondata) {
  const metaData = {};
  const { Outputs } = stackDescriptiondata.Stacks[0];
  Outputs.forEach(element => {
    metaData[element.OutputKey] = element.OutputValue;
  });
  metaData[constants.AmplifyAppIdLabel] = amplifyAppId;

  context.exeInfo.amplifyMeta = {};
  if (!context.exeInfo.amplifyMeta.providers) {
    context.exeInfo.amplifyMeta.providers = {};
  }
  context.exeInfo.amplifyMeta.providers[constants.ProviderName] = metaData;

  if (context.exeInfo.isNewEnv) {
    const { envName } = context.exeInfo.localEnvInfo;
    context.exeInfo.teamProviderInfo[envName] = {};
    context.exeInfo.teamProviderInfo[envName][constants.ProviderName] = metaData;
  }
}

async function onInitSuccessful(context) {
  configurationManager.onInitSuccessful(context);
  if (context.exeInfo.isNewEnv) {
    context = await storeCurrentCloudBackend(context);
    await storeArtifactsForAmplifyService(context);
  }
  return context;
}

function storeCurrentCloudBackend(context) {
  const zipFilename = '#current-cloud-backend.zip';
  const backendDir = context.amplify.pathManager.getBackendDirPath();
  const tempDir = `${backendDir}/.temp`;
  const currentCloudBackendDir = context.exeInfo
    ? `${context.exeInfo.localEnvInfo.projectPath}/amplify/#current-cloud-backend`
    : context.amplify.pathManager.getCurrentCloudBackendDirPath();

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const zipFilePath = path.normalize(path.join(tempDir, zipFilename));
  return archiver
    .run(currentCloudBackendDir, zipFilePath)
    .then(result => {
      const s3Key = `${result.zipFilename}`;
      return new S3(context).then(s3 => {
        const s3Params = {
          Body: fs.createReadStream(result.zipFilePath),
          Key: s3Key,
        };
        return s3.uploadFile(s3Params);
      });
    })
    .then(() => {
      fs.removeSync(tempDir);
      return context;
    });
}

function storeArtifactsForAmplifyService(context) {
  return new S3(context).then(async s3 => {
    const currentCloudBackendDir = context.amplify.pathManager.getCurrentCloudBackendDirPath();
    const amplifyMetaFilePath = path.join(currentCloudBackendDir, 'amplify-meta.json');
    const backendConfigFilePath = path.join(currentCloudBackendDir, 'backend-config.json');
    const fileUploadTasks = [];

    fileUploadTasks.push(() => uploadFile(s3, amplifyMetaFilePath, 'amplify-meta.json'));
    fileUploadTasks.push(() => uploadFile(s3, backendConfigFilePath, 'backend-config.json'));
    await sequential(fileUploadTasks);
  });
}

async function uploadFile(s3, filePath, key) {
  if (fs.existsSync(filePath)) {
    const s3Params = {
      Body: fs.createReadStream(filePath),
      Key: key,
    };
    await s3.uploadFile(s3Params);
  }
}

function normalizeStackName(stackName) {
  let result = stackName.toLowerCase().replace(/[^-a-z0-9]/g, '');
  if (/^[^a-zA-Z]/.test(result) || result.length === 0) {
    result = `a${result}`;
  }
  return result;
}

module.exports = {
  run,
  onInitSuccessful,
};
