import {
    Controller, Get, Post, Put, Delete, Param, Body, Req, UseGuards, HttpStatus, Res,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { HostsService } from './hosts.service';
import { TagsService } from '../tags/tags.service';

@Controller('hosts')
@UseGuards(AuthGuard)
export class HostsController {
    constructor(
        private hostsService: HostsService,
        private tagsService: TagsService,
    ) { }

    @Get()
    async findAll(@Req() req: any) {
        const hosts = await this.hostsService.findAllByUser(req.user.id);
        return { hosts };
    }

    @Post()
    async create(@Req() req: any, @Body() body: any, @Res() res: Response) {
        const { name, hostname, username } = body;
        if (!name || !hostname || !username) {
            return res.status(400).json({ error: 'Name, hostname, and username are required' });
        }
        const host = await this.hostsService.create(req.user.id, body);
        return res.status(201).json({ host });
    }

    // Copying a host server-side keeps the stored password out of the browser:
    // the encrypted blob is carried over as it is, and the client only ever
    // sends the handful of fields that actually differ.
    @Post(':id/duplicate')
    async duplicate(@Req() req: any, @Param('id') id: string, @Body() body: any, @Res() res: Response) {
        const { name, hostname } = body;
        if (!name || !hostname) {
            return res.status(400).json({ error: 'Name and hostname are required' });
        }
        const host = await this.hostsService.duplicate(req.user.id, id, body);
        if (!host) {
            return res.status(404).json({ error: 'Host not found' });
        }
        return res.status(201).json({ host });
    }

    @Put(':id')
    async update(@Req() req: any, @Param('id') id: string, @Body() body: any, @Res() res: Response) {
        const host = await this.hostsService.update(req.user.id, id, body);
        if (!host) {
            return res.status(404).json({ error: 'Host not found' });
        }
        return res.json({ host });
    }

    // Tags arrive as "key:value" strings and unknown ones are created on the
    // spot, so the client never has to resolve an id before tagging anything.
    @Put(':id/tags')
    async setTags(@Req() req: any, @Param('id') id: string, @Body() body: any, @Res() res: Response) {
        const tags = Array.isArray(body?.tags) ? body.tags : [];
        const result = await this.tagsService.setHostTags(req.user.id, id, tags);
        if (!result) return res.status(404).json({ error: 'Host not found' });
        return res.json({ tags: result });
    }

    @Delete(':id')
    async remove(@Req() req: any, @Param('id') id: string, @Res() res: Response) {
        const deleted = await this.hostsService.delete(req.user.id, id);
        if (!deleted) {
            return res.status(404).json({ error: 'Host not found' });
        }
        return res.json({ message: 'Host deleted' });
    }
}
