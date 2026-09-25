import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { httpError } from '../../shared/http-error.js';
const execute = promisify(execFile);
export const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
export async function validateVideo(path, metadata) {
  try {
    const {stdout} = await execute('ffprobe', ['-v','error','-max_alloc','268435456','-protocol_whitelist','file','-format_whitelist','mov','-show_streams','-show_format','-of','json',path], {timeout:120000,maxBuffer:1024*1024,windowsHide:true});
    const info=JSON.parse(stdout), streams=info.streams ?? [], v=streams[0];
    const fps=String(v?.avg_frame_rate).split('/').map(Number);
    if (streams.length!==1 || v.codec_type!=='video' || v.codec_name!=='h264' || v.width!==metadata.width || v.height!==metadata.height ||
        !['yuv420p','yuvj420p'].includes(v.pix_fmt) || Number(v.nb_frames)!==metadata.frames || fps[0]/fps[1]!==metadata.fps ||
        Math.abs(Number(info.format?.duration)-metadata.frames/metadata.fps)>0.1 || !String(info.format?.format_name).split(',').includes('mp4')) throw new Error('profile mismatch');
    await execute('ffmpeg',['-v','error','-xerror','-max_alloc','268435456','-protocol_whitelist','file','-format_whitelist','mov','-threads','2','-i',path,'-map','0:v:0','-f','null','-'],{timeout:120000,maxBuffer:1024*1024,windowsHide:true});
  } catch (e) {
    if (e.code==='ENOENT') throw httpError(503,'Video validation tools are unavailable');
    throw httpError(422,'Invalid MP4: expected a complete H.264 video matching the reserved preset');
  }
}
