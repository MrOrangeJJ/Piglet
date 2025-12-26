declare module 'screenshot-desktop' {
    function screenshot(options?: { format?: string; screen?: string }): Promise<Buffer>;
    namespace screenshot {
        function listDisplays(): Promise<{ id: string; name: string }[]>;
    }
    export = screenshot;
}
