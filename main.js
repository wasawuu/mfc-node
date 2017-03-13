'use strict';

var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var mv = require('mv');
var moment = require('moment');
var colors = require('colors');
var mkdirp = require('mkdirp');
var WebSocketClient = require('websocket').client;
var yaml = require('js-yaml');
var _ = require('underscore');
var path = require('path');
var bhttp = require('bhttp');
var session = bhttp.session();
var childProcess = require('child_process');
var HttpDispatcher = require('httpdispatcher');
var dispatcher = new HttpDispatcher();
var http = require('http');

var onlineModels = []; // the list of models from myfreecams.com
var capturingModels = []; // the list of currently capturing models
var localModels = [];  // "cached" copy of onlineModels (primarily for index.html)

var config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

config.port = config.port || 9080;
config.minFileSizeMb = config.minFileSizeMb || 0;
config.models = Array.isArray(config.models) ? config.models : [];
config.queue = Array.isArray(config.queue) ? config.queue : [];

var captureDirectory = path.resolve(config.captureDirectory || './capture');
var completeDirectory = path.resolve(config.completeDirectory || './complete');

function mkdir(dir) {
  mkdirp(dir, (err) => {
    if (err) {
      printErrorMsg(err);
      process.exit(1);
    }
  });
}

function getCurrentDateTime() {
  return moment().format('YYYY-MM-DDTHHmmss'); // The only true way of writing out dates and times, ISO 8601
}

function printMsg(msg) {
  console.log(colors.blue(`[${getCurrentDateTime()}]`), msg);
}

function printErrorMsg(msg) {
  console.log(colors.blue(`[${getCurrentDateTime()}]`), colors.red('[ERROR]'), msg);
}

function printDebugMsg(msg) {
  if (config.debug && msg) {
    console.log(colors.blue(`[${getCurrentDateTime()}]`), colors.yellow('[DEBUG]'), msg);
  }
}

function getTimestamp() {
  return Math.floor(new Date().getTime() / 1000);
}

function remove(value, array) {
  var idx = array.indexOf(value);

  if (idx !== -1) {
    array.splice(idx, 1);
  }
}

function getFileno() {
  return new Promise((resolve, reject) => {
    var client = new WebSocketClient();

    client.on('connectFailed', (err) => {
      reject(err);
    });

    client.on('connect', (connection) => {
      connection.on('error', (err) => {
        reject(err);
      });

      connection.on('message', (message) => {
        if (message.type === 'utf8') {
          var parts = /\{%22fileno%22:%22([0-9_]*)%22\}/.exec(message.utf8Data);

          if (parts && parts[1]) {
            printDebugMsg(`fileno = ${parts[1]}`);

            connection.close();
            resolve(parts[1]);
          }
        }
      });

      connection.sendUTF('hello fcserver\n\0');
      connection.sendUTF('1 0 0 20071025 0 guest:guest\n\0');
    });

    client.connect('ws://xchat20.myfreecams.com:8080/fcsl', '', 'http://xchat20.myfreecams.com:8080', { Cookie: 'company_id=3149; guest_welcome=1; history=7411522,5375294' });
  }).timeout(30000); // 30 secs
}

function getOnlineModels(fileno) {
  return Promise
    .try(() => session.get(`http://www.myfreecams.com/mfc2/php/mobj.php?f=${fileno}&s=xchat20`))
    .then((response) => {
      var rawHTML;
      var data;

      try {
        rawHTML = response.body.toString('utf8');
        rawHTML = rawHTML.substring(rawHTML.indexOf('{'), rawHTML.indexOf('\n') - 1);
        rawHTML = rawHTML.replace(/[^\x20-\x7E]+/g, '');

        data = JSON.parse(rawHTML);
      } catch (err) {
        throw new Error('Failed to parse data');
      }

      onlineModels = [];

      for (let key in data) {
        if (data.hasOwnProperty(key) && typeof data[key].nm !== 'undefined' && typeof data[key].uid !== 'undefined') {
          onlineModels.push({
            m: {
              camscore: data[key].m.camscore,
              missmfc: data[key].m.missmfc,
              new_model: data[key].m.new_model,
              rc: data[key].m.rc
            },
            nm: data[key].nm,
            u: {
              age: data[key].u.age,
              camserv: data[key].u.camserv,
              city: data[key].u.city,
              country: data[key].u.country
            },
            uid: data[key].uid,
            vs: data[key].vs
          });
        }
      }

      printMsg(`${onlineModels.length} model(s) online`);
    })
    .timeout(30000); // 30 secs
}

// goes through the models in the queue and updates their settings in config
function updateConfigModels() {
  return Promise
    .try(() => {
      printDebugMsg(`${config.queue.length} model(s) in the queue`);

      var isDirty = false;

      // move models from the queue to config
      config.queue = _.filter(config.queue, (queueModel) => {
        var uid = queueModel.uid;

        // if we don't have uid of the model, then we try to find the model's record by her name then get uid
        if (_.isUndefined(uid)) {
          let onlineModel = _.findWhere(onlineModels, { nm: queueModel.nm });

          // if we could find the model by her name we keep her in the queue
          if (_.isUndefined(onlineModel)) {
            return true;
          }

          uid = onlineModel.uid;
        }

        var configModel = _.findWhere(config.models, { uid: uid });

        if (_.isUndefined(configModel)) {
          config.models.push({ uid: uid, mode: queueModel.mode });
        } else {
          configModel.mode = queueModel.mode;
        }

        isDirty = true;

        return false;
      });

      // remove duplicates
      if (isDirty) {
        config.models = _.uniq(config.models, (m) => {
          return m.uid;
        });

        printDebugMsg('Save changes in config.yml');

        fs.writeFileSync('config.yml', yaml.safeDump(config), 0, 'utf8');
      }
    });
}

function selectMyModels() {
  return Promise
    .try(() => {
      printDebugMsg(`${config.models.length} model(s) in config`);

      var myModels = [];
      var isDirty = false;

      _.each(config.models, (configModel) => {
        var onlineModel = _.findWhere(onlineModels, { uid: configModel.uid });

        // if undefined then the model is offline
        if (_.isUndefined(onlineModel)) {
          return; // skip the rest of the function
        }

        onlineModel.mode = configModel.mode;

        if (onlineModel.mode === 1) {
          if (onlineModel.vs === 0 || onlineModel.vs === 90) {
            myModels.push(onlineModel);
          } else {
            printMsg(`${colors.green(onlineModel.nm)} is away or in a private`);
          }
        }

        // save the name of the model in config
        if (!configModel.nm) {
          configModel.nm = onlineModel.nm;
          isDirty = true;
        }
      });

      if (isDirty) {
        printDebugMsg('Save changes in config.yml');

        fs.writeFileSync('config.yml', yaml.safeDump(config), 0, 'utf8');
      }

      printDebugMsg(myModels.length + ' model(s) to capture');

      return myModels;
    });
}

function createCaptureProcess(myModel) {
  let capturingModel = _.findWhere(capturingModels, { uid: myModel.uid });

  if (!_.isUndefined(capturingModel)) {
    printDebugMsg(colors.green(myModel.nm) + ' is already capturing');

    return; // resolve immediately
  }

  printMsg(colors.green(myModel.nm) + ' is now online, starting capturing process');

  return Promise
    .try(() => {
      var filename = `${myModel.nm}-${getCurrentDateTime()}.ts`;

      var captureProcess = childProcess.spawn('ffmpeg', [
        '-hide_banner',
        '-v',
        'fatal',
        '-i',
        `http://video${myModel.u.camserv - 500}.myfreecams.com:1935/NxServer/ngrp:mfc_${100000000 + myModel.uid}.f4v_mobile/playlist.m3u8?nc=1423603882490`,
        '-c',
        'copy',
        `${captureDirectory}/${filename}`
      ]);

      if (!captureProcess.pid) {
        return;
      }

      captureProcess.stdout.on('data', (data) => {
        printMsg(data.toString);
      });

      captureProcess.stderr.on('data', (data) => {
        printMsg(data.toString);
      });

      captureProcess.on('close', (code) => {
        printMsg(`${colors.green(myModel.nm)} stopped streaming`);

        var stoppedModel = _.findWhere(capturingModels, { pid: captureProcess.pid });

        if (!_.isUndefined(stoppedModel)) {
          remove(stoppedModel, capturingModels);
        }

        fs.stat(`${captureDirectory}/${filename}`, (err, stats) => {
          if (err) {
            if (err.code !== 'ENOENT') {
              printErrorMsg('[' + colors.green(myModel.nm) + '] ' + err.toString());
            }
          } else if (stats.size <= (config.minFileSizeMb * 1048576)) {
            fs.unlink(captureDirectory + '/' + filename, (e) => {
              // do nothing, shit happens
            });
          } else {
            mv(captureDirectory + '/' + filename, completeDirectory + '/' + filename, (e) => {
              if (e) {
                printErrorMsg('[' + colors.green(myModel.nm) + '] ' + e.toString());
              }
            });
          }
        });
      });

      capturingModels.push({
        nm: myModel.nm,
        uid: myModel.uid,
        filename: filename,
        captureProcess: captureProcess,
        pid: captureProcess.pid,
        checkAfter: getTimestamp() + 600, // we are gonna check this process after 10 min
        size: 0
      });
    })
    .catch((err) => {
      printErrorMsg('[' + colors.green(myModel.nm) + '] ' + err.toString());
    });
}

function checkCaptureProcess(capturingModel) {
  var onlineModel = _.findWhere(onlineModels, { uid: capturingModel.uid });

  if (!_.isUndefined(onlineModel)) {
    if (onlineModel.mode === 1) {
      onlineModel.capturing = true;
    } else if (!_.isUndefined(capturingModel.captureProcess)) {
      // if the model has been excluded or deleted we stop capturing process and resolve immediately
      printDebugMsg(colors.green(capturingModel.nm) + ' has to be stopped');

      capturingModel.captureProcess.kill();
      return;
    }
  }

  // if this is not the time to check the process then we resolve immediately
  if (capturingModel.checkAfter > getTimestamp()) {
    return;
  }

  return fs
    .statAsync(captureDirectory + '/' + capturingModel.filename)
    .then((stats) => {
      // we check the process every 10 minutes since its start,
      // if the size of the file has not changed for the last 10 min, we kill the process
      if (stats.size - capturingModel.size > 0) {
        printDebugMsg(colors.green(capturingModel.nm) + ' is alive');

        capturingModel.checkAfter = getTimestamp() + 600; // 10 minutes
        capturingModel.size = stats.size;
      } else if (!_.isUndefined(capturingModel.captureProcess)) {
        // we assume that onClose will do all clean up for us
        printErrorMsg('[' + colors.green(capturingModel.nm) + '] Process is dead');
        capturingModel.captureProcess.kill();
      } else {
        // suppose here we should forcefully remove the model from capturingModels
        // because her captureProcess is unset, but let's leave this as is
        // remove(capturingModel, capturingModels);
      }
    })
    .catch((err) => {
      if (err.code === 'ENOENT') {
        // do nothing, file does not exists,
        // this is kind of impossible case, however, probably there should be some code to "clean up" the process
      } else {
        printErrorMsg('[' + colors.green(capturingModel.nm) + '] ' + err.toString());
      }
    });
}

function mainLoop() {
  printDebugMsg('Start new cycle');

  Promise
    .try(() => getFileno())
    .then(fileno => getOnlineModels(fileno))
    .then(() => updateConfigModels()) // move models from the queue to config
    .then(() => selectMyModels())
    .then(myModels => Promise.all(myModels.map(createCaptureProcess)))
    .then(() => Promise.all(capturingModels.map(checkCaptureProcess)))
    .then(() => {
      localModels = _.reject(onlineModels, onlineModel => (onlineModel.mode === -1));
    })
    .catch((err) => {
      printErrorMsg(err);
    })
    .finally(() => {
      if (config.debug) {
        printDebugMsg('capturingModels:');
        _.each(capturingModels, (capturingModel) => {
          console.log(capturingModel.pid, capturingModel.checkAfter, capturingModel.filename, capturingModel.size);
        });
      }

      printMsg('Done, will search for new models in ' + config.modelScanInterval + ' second(s).');

      setTimeout(mainLoop, config.modelScanInterval * 1000);
    });
}

function addInQueue(req, res, mode) {
  var model;

  if (req.params && req.params.uid) {
    let uid = parseInt(req.params.uid, 10);

    if (!isNaN(uid)) {
      printDebugMsg(colors.green(uid) + ' to ' + (mode === 1 ? 'include' : (mode === 0 ? 'exclude' : 'delete')));

      config.queue.push({
        uid: uid,
        mode: mode
      });

      model = { uid: uid };
    }
  } else if (req.params && req.params.nm) {
    printDebugMsg(colors.green(req.params.nm) + ' to ' + (mode === 1 ? 'include' : (mode === 0 ? 'exclude' : 'delete')));

    config.queue.push({
      nm: req.params.nm,
      mode: mode
    });

    model = { nm: req.params.nm };
  }

  if (_.isUndefined(model)) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request' }));
  } else {
    let localModel = _.findWhere(localModels, model);

    if (!_.isUndefined(localModel)) {
      localModel.nextMode = mode;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(model)); // this will be sent back to the browser
  }
}

mkdir(captureDirectory);
mkdir(completeDirectory);

mainLoop();

dispatcher.onGet('/', (req, res) => {
  fs.readFile('./index.html', (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data, 'utf-8');
    }
  });
});

// return an array of online models
dispatcher.onGet('/models', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(localModels));
});

// when we include the model we only "express our intention" to do so,
// in fact the model will be included in the config only with the next iteration of mainLoop
dispatcher.onGet('/models/include', (req, res) => {
  addInQueue(req, res, 1);
});

// whenever we exclude the model we only "express our intention" to do so,
// in fact the model will be exclude from config only with the next iteration of mainLoop
dispatcher.onGet('/models/exclude', (req, res) => {
  addInQueue(req, res, 0);
});

// whenever we delete the model we only "express our intention" to do so,
// in fact the model will be markd as "deleted" in config only with the next iteration of mainLoop
dispatcher.onGet('/models/delete', (req, res) => {
  addInQueue(req, res, -1);
});

dispatcher.onError((req, res) => {
  res.writeHead(404);
});

http.createServer((req, res) => {
  dispatcher.dispatch(req, res);
}).listen(config.port, () => {
  printMsg('Server listening on: ' + colors.green('0.0.0.0:' + config.port));
});
