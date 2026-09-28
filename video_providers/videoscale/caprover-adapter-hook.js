// CapRover adapter pre-deploy script. Same internal key, no database/cloud keys.
var preDeployFunction = function (captainAppObj, dockerUpdateObject) {
  return Promise.resolve().then(function () {
    var key = require("fs")
      .readFileSync("/captain/data/musicmute-acquisition/api-key", "utf8")
      .trim();
    if (key.length < 32 || key.length > 256)
      throw new Error("Missing private acquisition service key");
    var spec = dockerUpdateObject.TaskTemplate.ContainerSpec;
    spec.Env = (spec.Env || []).filter(function (entry) {
      return !entry.startsWith("AUDIO_ACQUISITION_API_KEY=");
    });
    spec.Env.push("AUDIO_ACQUISITION_API_KEY=" + key);
    return dockerUpdateObject;
  });
};
