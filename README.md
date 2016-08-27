mfc-node
==========

mfc-node lets you follow and archive your favorite models' shows on myfreecams.com

This is an attempt to create a script similar to [capturbate-node](https://github.com/SN4T14/capturebate-node) based on different pieces of code found in the Internet.

Credits:
* [capturbate-node](https://github.com/SN4T14/capturebate-node)

* [Sembiance/get_mfc_video_url.js](https://gist.github.com/Sembiance/df151de0006a0bf8ae54)

Requirements
==========
(Debian 7, minimum)

[Node.js](https://nodejs.org/download/) used to run mfc-node, hence the name.

[ffmpeg](https://www.ffmpeg.org/download.html)

Setup
===========

Install requirements, run `npm install` in the same folder as main.js is.

Edit `config.yml` file and set desirable values for `captureDirectory`, `completeDirectory`, `modelScanInterval`.

Open `updates.yml` file and add names of your favorite models in `includeModels`.
```
includeModels: [aaaa, bbbb, cccc]
```
or
```
includeModels:
  - aaaa # two spaces + dash + space + model's name
  - bbbb
  - cccc
```
For more details please check YAML specification for [collections](http://symfony.com/doc/current/components/yaml/yaml_format.html#collections).

Be mindful when capturing many streams at once to have plenty of space on disk and the bandwidth available or you’ll end up dropping a lot of frames and the files will be useless.

Running
===========

To start capturing streams you need to run `node main.js` I recommend you do this in [screen](https://www.gnu.org/software/screen/) as that'll keep running if you lose connection to the machine or otherwise close your shell.

For advanced users only
===========

This section is for advance users to explain the main logic of the script and some other options.

The script reads `config.yml` file only once at start therefore if you want to add or remove models you should do this through `updates.yml` file. The script checks this file every `modelScanInterval` and if it finds models to include or exclude it moves them to `config.yml` file.

You still can edit `config.yml` directly, but this should be done when the script is not running otherwise there is a possibility to lose all changes you made.

If the model you want to exclude has a running capturing process this process will be not terminated until the model stops streaming, however, the script will not start capturing this model next time when she goes online.

The `models` collection has been changed from the "flat list" to the collection of "objects". The script will automatically convert `models` collection to the new format at the start. Each model's "object" will have fields: 'uid', 'nm' and 'excluded'(this one is optional):
* `uid` - this is id of the model,
* `nm` - "local" name of the model. The default value for this field will be the model's name, however you can change it to any value you want. This field is used to generate filenames and allows to avoid situation when the model constantly changes her name (please do not use the same name for different models),
* `excluded` - if the field is set and is equal true, the script will ignore this model and not create a capturing process when the model goes online. You can set this flag either manually by editing `config.yml` file or by adding model's name in `includeModels` (will set `excluded` to false) or by adding model's name in `excludedModels` (will set `excluded` to true).






