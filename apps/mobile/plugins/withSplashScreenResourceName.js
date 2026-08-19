const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

module.exports = function withSplashScreenResourceName(config) {
  return withDangerousMod(config, [
    'ios',
    async (mod) => {
      const projectRoot = mod.modRequest.projectRoot;
      const projectDirectory = path.join(
        mod.modRequest.platformProjectRoot,
        mod.modRequest.projectName,
      );
      const storyboardPath = path.join(
        projectDirectory,
        'SplashScreen.storyboard',
      );
      const contents = await fs.promises.readFile(storyboardPath, 'utf8');
      const patched = contents.replace(
        'image="SplashScreen"',
        'image="SplashScreenLogo"',
      );

      if (patched !== contents) {
        await fs.promises.writeFile(storyboardPath, patched);
      }

      const imagesetDirectory = path.join(
        projectDirectory,
        'Images.xcassets',
        'SplashScreenLogo.imageset',
      );
      await fs.promises.mkdir(imagesetDirectory, { recursive: true });
      await fs.promises.copyFile(
        path.join(projectRoot, 'assets', 'splash-icon.png'),
        path.join(imagesetDirectory, 'splash-icon.png'),
      );
      await fs.promises.writeFile(
        path.join(imagesetDirectory, 'Contents.json'),
        JSON.stringify(
          {
            images: [
              {
                filename: 'splash-icon.png',
                idiom: 'universal',
                scale: '1x',
              },
            ],
            info: { author: 'expo', version: 1 },
          },
          null,
          2,
        ) + '\n',
      );

      return mod;
    },
  ]);
};
