'use strict';

var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var string = require('string');
var yaml = require('js-yaml');
var colors = require('colors');
var childProcess = require('child_process');
var mkdirp = require('mkdirp');
var path = require('path');
var moment = require('moment');
var _ = require('underscore');

function getCurrentDateTime() {
  return moment().format('YYYY-MM-DDTHHmmss'); // The only true way of writing out dates and times, ISO 8601
}

function printMsg(msg) {
  console.log(colors.blue(`[${getCurrentDateTime()}]`), msg);
}

function printErrorMsg(msg) {
  console.log(colors.blue(`[${getCurrentDateTime()}]`), colors.red('[ERROR]'), msg);
}

function getTimestamp() {
  return Math.floor(new Date().getTime() / 1000);
}

var startTs;
var config = yaml.safeLoad(fs.readFileSync('convert.yml', 'utf8'));

var srcDirectory = path.resolve(config.srcDirectory || './complete');
var dstDirectory = path.resolve(config.dstDirectory || './converted');
var dirScanInterval = config.dirScanInterval || 300;

mkdirp.sync(srcDirectory);
mkdirp.sync(dstDirectory);

function getFiles() {
  return fs
    .readdirAsync(srcDirectory)
    .then(files => _.filter(files, file => string(file).endsWith('.ts') || string(file).endsWith('.flv')));
}

function convertFile(srcFile) {
  var dstFile;
  var spawnArguments;

  if (string(srcFile).endsWith('.ts')) {
    dstFile = string(srcFile).chompRight('ts').s + 'mp4';

    spawnArguments = [
      '-i',
      srcDirectory + '/' + srcFile,
      '-y',
      '-hide_banner',
      '-loglevel',
      'panic',
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      '-bsf:a',
      'aac_adtstoasc',
      '-copyts',
      srcDirectory + '/' + dstFile
    ];
  } else if (string(srcFile).endsWith('.flv')) {
    dstFile = string(srcFile).chompRight('flv').s + 'mp4';

    spawnArguments = [
      '-i',
      srcDirectory + '/' + srcFile,
      '-y',
      '-hide_banner',
      '-loglevel',
      'panic',
      '-movflags',
      '+faststart',
      '-c:v',
      'copy',
      '-strict',
      '-2',
      '-q:a',
      '100',
      srcDirectory + '/' + dstFile
    ];
  }

  if (!dstFile) {
    printErrorMsg(`Failed to convert ${srcFile}`);

    return;
  }

  printMsg(`Converting ${srcFile} to ${dstFile}`);

  var convertProcess = childProcess.spawnSync('ffmpeg', spawnArguments);

  if (convertProcess.status !== 0) {
    printErrorMsg(`Failed to convert ${srcFile}`);

    if (convertProcess.error) {
      printErrorMsg(convertProcess.error.toString());
    }

    return;
  }

  if (config.deleteAfter) {
    fs.unlink(srcDirectory + '/' + srcFile, (err) => {
      // do nothing, shit happens
    });
  } else {
    fs.rename(srcDirectory + '/' + srcFile, dstDirectory + '/' + srcFile, (err) => {
      if (err) {
        printErrorMsg(err.toString());
      }
    });
  }

  fs.rename(srcDirectory + '/' + dstFile, dstDirectory + '/' + dstFile, (err) => {
    if (err) {
      printErrorMsg(err.toString());
    }
  });
}

function mainLoop() {
  startTs = getTimestamp();

  Promise
    .try(() => getFiles())
    .then((files) => {
      if (files.length > 0) {
        printMsg(files.length + ' file(s) to convert');
        _.each(files, convertFile);
      } else {
        printMsg('No files found');
      }
    })
    .catch((err) => {
      printErrorMsg(err);
    })
    .finally(() => {
      var seconds = startTs - getTimestamp() + dirScanInterval;

      if (seconds < 5) {
        seconds = 5;
      }

      printMsg('Done, will scan the folder in ' + seconds + ' second(s).');

      setTimeout(mainLoop, seconds * 1000);
    });
}

mainLoop();
