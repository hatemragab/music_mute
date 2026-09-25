// Install as the API app's Pre-Deploy Script. No key is stored in this file.
var preDeployFunction = function (captainAppObj, dockerUpdateObject) {
  return Promise.resolve().then(function () {
    var key = require('fs').readFileSync('/captain/data/musicmute-ytdlp/api-key', 'utf8').trim();
    if (key.length < 32 || key.length > 256) throw new Error('Missing downloader service key');
    var spec = dockerUpdateObject.TaskTemplate.ContainerSpec;
    spec.Env = (spec.Env || []).filter(function (entry) { return !entry.startsWith('YTDLP_API_KEY='); });
    spec.Env.push('YTDLP_API_KEY=' + key);
    return dockerUpdateObject;
  });
};
