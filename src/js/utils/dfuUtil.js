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

function uniqueExistingFirst(candidates) {
    const unique = [...new Set(candidates.filter(Boolean))];
    const existing = unique.filter((candidate) => path.isAbsolute(candidate) && fs.existsSync(candidate));
    const unresolved = unique.filter((candidate) => !existing.includes(candidate));

    return [...existing, ...unresolved];
}

function getWindowsProgramFilesCandidates(relativePath) {
    return [
        process.env.ProgramFiles,
        process.env['ProgramFiles(x86)'],
        process.env.ProgramW6432,
    ].map((root) => root && path.join(root, relativePath));
}

function getCubeProgrammerCandidates() {
    const candidates = [
        process.env.STM32CUBE_PROGRAMMER_CLI,
        process.env.STM32CUBEPRG_CLI,
    ];

    switch (GUI.operating_system) {
        case 'Windows':
            candidates.push(
                ...getWindowsProgramFilesCandidates(path.join('STMicroelectronics', 'STM32Cube', 'STM32CubeProgrammer', 'bin', 'STM32_Programmer_CLI.exe')),
                ...getWindowsProgramFilesCandidates(path.join('STMicroelectronics', 'STM32CubeProgrammer', 'bin', 'STM32_Programmer_CLI.exe')),
                'STM32_Programmer_CLI.exe'
            );
            break;
        case 'MacOS':
            candidates.push(
                '/Applications/STMicroelectronics/STM32Cube/STM32CubeProgrammer/STM32CubeProgrammer.app/Contents/MacOs/bin/STM32_Programmer_CLI',
                '/Applications/STMicroelectronics/STM32CubeProgrammer/STM32CubeProgrammer.app/Contents/MacOs/bin/STM32_Programmer_CLI',
                'STM32_Programmer_CLI'
            );
            break;
        default:
            candidates.push(
                '/usr/local/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin/STM32_Programmer_CLI',
                '/opt/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin/STM32_Programmer_CLI',
                'STM32_Programmer_CLI',
                'STM32_Programmer.sh'
            );
            break;
    }

    return uniqueExistingFirst(candidates);
}

function getDfuUtilCandidates() {
    const candidates = [];

    if (process.env.DFU_UTIL_PATH) {
        candidates.push(process.env.DFU_UTIL_PATH);
    }

    if (GUI.operating_system === 'Windows') {
        candidates.push('dfu-util.exe');
    }

    candidates.push('dfu-util');

    return uniqueExistingFirst(candidates);
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

function isExecutableNotFound(error) {
    return error.code === 'ENOENT';
}

function runTool(executable, args) {
    return new Promise((resolve) => {
        execFile(
            executable,
            args,
            { timeout: 10000, windowsHide: true },
            (error, stdout, stderr) => {
                if (error) {
                    resolve({
                        ok: false,
                        message: stderr || stdout || error.message,
                        notFound: isExecutableNotFound(error),
                    });
                    return;
                }

                resolve({
                    ok: true,
                    message: stdout || stderr,
                });
            }
        );
    });
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
                        ok: false,
                        message: stderr || stdout || error.message,
                        notFound: isExecutableNotFound(error),
                    });
                    return;
                }

                resolve({
                    ok: true,
                    message: stdout || stderr || 'dfu-util leave request completed',
                });
            }
        );
    });
}

async function tryToolCandidates(toolName, candidates, runner) {
    const failures = [];

    for (const executable of candidates) {
        const result = await runner(executable);

        if (result.ok) {
            return {
                exited: true,
                message: result.message || `${toolName} leave request completed`,
            };
        }

        failures.push(`${executable}: ${result.message}`);

        if (!result.notFound) {
            break;
        }
    }

    return {
        exited: false,
        message: failures.join('\n'),
    };
}

async function exitWithCubeProgrammer() {
    return tryToolCandidates(
        'STM32CubeProgrammer',
        getCubeProgrammerCandidates(),
        (executable) => runTool(executable, ['-c', 'port=USB1', '-s', STM32_FLASH_ADDRESS])
    );
}

async function exitWithDfuUtil() {
    return tryToolCandidates('dfu-util', getDfuUtilCandidates(), runDfuUtilLeave);
}

async function exitSTM32DFUWithExternalTool() {
    const cubeProgrammerResult = await exitWithCubeProgrammer();

    if (cubeProgrammerResult.exited) {
        return {
            supported: true,
            exited: true,
            tool: 'STM32CubeProgrammer',
            message: cubeProgrammerResult.message,
        };
    }

    const dfuUtilResult = await exitWithDfuUtil();

    if (dfuUtilResult.exited) {
        return {
            supported: true,
            exited: true,
            tool: 'dfu-util',
            message: dfuUtilResult.message,
        };
    }

    return {
        supported: false,
        exited: false,
        message: [
            `STM32CubeProgrammer: ${cubeProgrammerResult.message}`,
            `dfu-util: ${dfuUtilResult.message}`,
        ].join('\n'),
    };
}

export {
    exitSTM32DFUWithExternalTool,
};
