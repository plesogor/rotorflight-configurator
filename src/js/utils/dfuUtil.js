const { execFile } = globalThis.nw
    ? globalThis.nw.require('child_process')
    : require('child_process');
const fs = globalThis.nw
    ? globalThis.nw.require('fs')
    : require('fs');
const os = globalThis.nw
    ? globalThis.nw.require('os')
    : require('os');
const path = globalThis.nw
    ? globalThis.nw.require('path')
    : require('path');

const STM32_DFU_DEVICE = '0483:df11';
const STM32_FLASH_ADDRESS = '0x08000000';

function getDfuUtilCandidates() {
    const candidates = [];

    if (process.env.DFU_UTIL_PATH) {
        candidates.push(process.env.DFU_UTIL_PATH);
    }

    if (GUI.operating_system === 'Windows') {
        candidates.push('dfu-util.exe');
    }

    candidates.push('dfu-util');

    return [...new Set(candidates)];
}

function createEmptyDownloadFile() {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rotorflight-dfu-util-'));
    const filePath = path.join(tempDirectory, 'empty.bin');

    fs.writeFileSync(filePath, Buffer.alloc(0));

    return { tempDirectory, filePath };
}

function removeEmptyDownloadFile(tempDirectory) {
    try {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    } catch (error) {
        console.log(`Failed to remove dfu-util temporary file: ${error.message}`);
    }
}

function runDfuUtilLeave(executable) {
    return new Promise((resolve) => {
        const { tempDirectory, filePath } = createEmptyDownloadFile();
        const args = [
            '-a',
            '0',
            '-d',
            STM32_DFU_DEVICE,
            '-s',
            `${STM32_FLASH_ADDRESS}:leave`,
            '-D',
            filePath,
        ];

        execFile(
            executable,
            args,
            { timeout: 10000, windowsHide: true },
            (error, stdout, stderr) => {
                removeEmptyDownloadFile(tempDirectory);

                if (error) {
                    resolve({
                        exited: false,
                        message: stderr || stdout || error.message,
                        notFound: error.code === 'ENOENT',
                    });
                    return;
                }

                resolve({
                    exited: true,
                    message: stdout || stderr || 'dfu-util leave request completed',
                });
            }
        );
    });
}

async function exitSTM32DFUWithDfuUtil() {
    const failures = [];

    for (const executable of getDfuUtilCandidates()) {
        const result = await runDfuUtilLeave(executable);

        if (result.exited) {
            return {
                supported: true,
                exited: true,
                message: result.message,
            };
        }

        failures.push(`${executable}: ${result.message}`);

        if (!result.notFound) {
            break;
        }
    }

    return {
        supported: failures.length > 0,
        exited: false,
        message: failures.join('\n'),
    };
}

export {
    exitSTM32DFUWithDfuUtil,
};
