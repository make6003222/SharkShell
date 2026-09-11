import {
    Controller, Get, Post, Delete, Param, Body, Req, UseGuards, Res,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { TagsService } from './tags.service';

@Controller('tags')
@UseGuards(AuthGuard)
export class TagsController {
    constructor(private tagsService: TagsService) { }

    @Get()
    async findAll(@Req() req: any) {
        const tags = await this.tagsService.findAllByUser(req.user.id);
        return { tags };
    }

    // Tagging a fleet one host at a time is how tagging schemes get abandoned,
    // so adding and removing across a selection is a first-class operation.
    @Post('bulk')
    async bulk(@Req() req: any, @Body() body: any, @Res() res: Response) {
        const { hostIds, add, remove } = body || {};
        if (!Array.isArray(hostIds) || hostIds.length === 0) {
            return res.status(400).json({ error: 'hostIds must be a non-empty array' });
        }
        const result = await this.tagsService.bulkUpdate(req.user.id, hostIds, add || [], remove || []);
        return res.json(result);
    }

    @Post('prune')
    async prune(@Req() req: any) {
        return this.tagsService.pruneUnused(req.user.id);
    }

    @Delete(':id')
    async remove(@Req() req: any, @Param('id') id: string, @Res() res: Response) {
        const deleted = await this.tagsService.delete(req.user.id, id);
        if (!deleted) return res.status(404).json({ error: 'Tag not found' });
        return res.json({ message: 'Tag deleted' });
    }
}
