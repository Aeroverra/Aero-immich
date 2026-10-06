import { defaults } from 'src/dtos/config.dto';
import { ColorTransfer, ToneMapping } from 'src/enum';
import { VideoFrameConfig } from 'src/utils/media';
import { videoInfoStub } from 'test/fixtures/media.stub';
import { describe, expect, it } from 'vitest';

const videoStream = videoInfoStub.videoStreamH264.videoStreams[0];

describe(VideoFrameConfig.name, () => {
  it('should seek before the input and write one jpeg frame to stdout', () => {
    const config = VideoFrameConfig.create({ ...defaults.ffmpeg, targetResolution: '720' });

    const { inputOptions, outputOptions } = config.getFrameCommand(12_345, videoStream);

    expect(inputOptions.slice(0, 2)).toEqual(['-ss', '12.345']);
    expect(outputOptions).toEqual(expect.arrayContaining(['-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg']));
    expect(outputOptions[outputOptions.indexOf('-vf') + 1]).toContain('scale=');
  });

  it('should not pass an empty filter graph when no filter is needed', () => {
    const config = VideoFrameConfig.create({ ...defaults.ffmpeg, targetResolution: '1440' });

    const { outputOptions } = config.getFrameCommand(1000, videoStream);

    expect(outputOptions).not.toContain('-vf');
  });

  it('should tone-map hdr videos', () => {
    const config = VideoFrameConfig.create({
      ...defaults.ffmpeg,
      tonemap: ToneMapping.Hable,
      targetResolution: '1440',
    });

    const { outputOptions } = config.getFrameCommand(1000, { ...videoStream, colorTransfer: ColorTransfer.Smpte2084 });

    expect(outputOptions[outputOptions.indexOf('-vf') + 1]).toContain('tonemapx');
  });
});
