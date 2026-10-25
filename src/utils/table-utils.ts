import { PagePool } from '../components/page-pool';
import { AppError } from './errors';

export async function splitPagePrepare(pagePool: PagePool, table: string, pageId: number) {
    const leftPage = (await pagePool.getPage(table, pageId))?.clone();
    if (!leftPage) {
      throw new AppError('PAGE_NOT_FOUND', { pageId, table });
    }
    const pageType = leftPage.getPageType();

    const { pageManager: newPage, id: newPageId } = await pagePool.allocatePage(table);
    newPage.init(pageType);

    return {
      leftPage,
      leftPageId: pageId,
      newPage: newPage.clone(),
      newPageId,
      pageType,
      slotCount: leftPage.getSlotCount(),
    };
}

