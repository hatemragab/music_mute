// CapRover pre-deploy hook. Read protected runtime service keys; never vendor keys.
var preDeployFunction = function (captainAppObj, dockerUpdateObject) {
  return Promise.resolve().then(function () {
    var configured = Array.isArray(captainAppObj.envVars)
      ? captainAppObj.envVars.filter(function (entry) {
          return entry && entry.key === "YOUTUBE_AUDIO_ACQUISITION_API_URL";
        })
      : [];
    var selected = configured.length === 1 ? configured[0].value : null;
    var target =
      typeof selected === "string" && !/[\s\\]/.test(selected)
        ? /^http:\/\/(?:srv-captain--)?music-mute-(tunelio|jojapi):8080\/?$/.exec(
            selected,
          )
        : null;
    if (!target) throw new Error("Missing valid private YouTube destination");
    var fs = require("fs");
    var readKey = function (path) {
      var value = fs.readFileSync(path, "utf8").trim();
      if (!/^[!-~]{32,256}$/.test(value))
        throw new Error("Missing private acquisition service key");
      return value;
    };
    var commonKey = readKey("/captain/data/musicmute-acquisition/api-key");
    var youtubeKey = readKey(
      "/captain/data/musicmute-acquisition/" + target[1] + "-api-key",
    );
    var keys = [
      "AUDIO_ACQUISITION_API_KEY",
      "OTHER_AUDIO_ACQUISITION_API_KEY",
      "YOUTUBE_AUDIO_ACQUISITION_API_KEY",
    ];
    var spec = dockerUpdateObject.TaskTemplate.ContainerSpec;
    spec.Env = (spec.Env || []).filter(function (entry) {
      return !keys.some(function (key) {
        return entry.startsWith(key + "=");
      });
    });
    spec.Env.push("AUDIO_ACQUISITION_API_KEY=" + commonKey);
    spec.Env.push("OTHER_AUDIO_ACQUISITION_API_KEY=" + commonKey);
    spec.Env.push("YOUTUBE_AUDIO_ACQUISITION_API_KEY=" + youtubeKey);
    return dockerUpdateObject;
  });
};
