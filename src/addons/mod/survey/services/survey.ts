// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Injectable } from '@angular/core';
import { CoreError } from '@classes/errors/error';
import { CoreCourseCommonModWSOptions } from '@features/course/services/course';
import { CoreCourseLogHelper } from '@features/course/services/log-helper';
import { CoreNetwork } from '@services/network';
import { CoreFilepool } from '@services/filepool';
import { CoreSites, CoreSitesCommonWSOptions } from '@services/sites';
import { CoreWSError } from '@classes/errors/wserror';
import { CoreStatusWithWarningsWSResponse, CoreWSExternalWarning } from '@services/ws';
import { makeSingleton } from '@singletons';
import { AddonModSurveyOffline } from './survey-offline';
import { CoreSiteWSPreSets } from '@classes/sites/authenticated-site';
import { ADDON_MOD_SURVEY_COMPONENT_LEGACY } from '../constants';
import { CoreCacheUpdateFrequency } from '@/core/constants';
import { CorePromiseUtils } from '@singletons/promise-utils';
import { CoreCourseModuleHelper, CoreCourseModuleStandardElements } from '@features/course/services/course-module-helper';

/**
 * Service that provides some features for surveys.
 */
@Injectable( { providedIn: 'root' })
export class AddonModSurveyProvider {

    protected static readonly ROOT_CACHE_KEY = 'mmaModSurvey:';

    /**
     * Get a survey's questions.
     *
     * @param surveyId Survey ID.
     * @param options Other options.
     * @returns Promise resolved when the questions are retrieved.
     */
    async getQuestions(surveyId: number, options: CoreCourseCommonModWSOptions = {}): Promise<AddonModSurveyQuestion[]> {
        const site = await CoreSites.getSite(options.siteId);

        const params: AddonModSurveyGetQuestionsWSParams = {
            surveyid: surveyId,
        };

        const preSets: CoreSiteWSPreSets = {
            cacheKey: this.getQuestionsCacheKey(surveyId),
            updateFrequency: CoreCacheUpdateFrequency.RARELY,
            component: ADDON_MOD_SURVEY_COMPONENT_LEGACY,
            componentId: options.cmId,
            ...CoreSites.getReadingStrategyPreSets(options.readingStrategy), // Include reading strategy preSets.
        };

        const response = await site.read<AddonModSurveyGetQuestionsWSResponse>('mod_survey_get_questions', params, preSets);
        if (response.questions) {
            return response.questions;
        }

        throw new CoreError('No questions were found.');
    }

    /**
     * Get cache key for survey questions WS calls.
     *
     * @param surveyId Survey ID.
     * @returns Cache key.
     */
    protected getQuestionsCacheKey(surveyId: number): string {
        return `${AddonModSurveyProvider.ROOT_CACHE_KEY}questions:${surveyId}`;
    }

    /**
     * Get cache key for survey data WS calls.
     *
     * @param courseId Course ID.
     * @returns Cache key.
     */
    protected getSurveyCacheKey(courseId: number): string {
        return `${AddonModSurveyProvider.ROOT_CACHE_KEY}survey:${courseId}`;
    }

    /**
     * Get a survey by course module ID.
     *
     * @param courseId Course ID.
     * @param cmId Course module ID.
     * @param options Other options.
     * @returns Promise resolved when the survey is retrieved.
     */
    async getSurvey(courseId: number, cmId: number, options: CoreSitesCommonWSOptions = {}): Promise<AddonModSurveySurvey> {
        const site = await CoreSites.getSite(options.siteId);

        const params: AddonModSurveyGetSurveysByCoursesWSParams = {
            courseids: [courseId],
        };

        const preSets: CoreSiteWSPreSets = {
            cacheKey: this.getSurveyCacheKey(courseId),
            updateFrequency: CoreCacheUpdateFrequency.RARELY,
            component: ADDON_MOD_SURVEY_COMPONENT_LEGACY,
            ...CoreSites.getReadingStrategyPreSets(options.readingStrategy), // Include reading strategy preSets.
        };

        const response =
            await site.read<AddonModSurveyGetSurveysByCoursesWSResponse>('mod_survey_get_surveys_by_courses', params, preSets);

        return CoreCourseModuleHelper.getActivityByCmId(response.surveys, cmId);
    }

    /**
     * Invalidate the prefetched content.
     *
     * @param moduleId The module ID.
     * @param courseId Course ID of the module.
     * @param siteId Site ID. If not defined, current site.
     */
    async invalidateContent(moduleId: number, courseId: number, siteId?: string): Promise<void> {
        siteId = siteId || CoreSites.getCurrentSiteId();

        const promises: Promise<void>[] = [];

        promises.push(this.getSurvey(courseId, moduleId).then(async (survey) => {
            const ps: Promise<void>[] = [];

            // Do not invalidate activity data before getting activity info, we need it!
            ps.push(this.invalidateSurveyData(courseId, siteId));
            ps.push(this.invalidateQuestions(survey.id, siteId));

            await Promise.all(ps);

            return;
        }));

        promises.push(CoreFilepool.invalidateFilesByComponent(siteId, ADDON_MOD_SURVEY_COMPONENT_LEGACY, moduleId));

        await CorePromiseUtils.allPromises(promises);
    }

    /**
     * Invalidates survey questions.
     *
     * @param surveyId Survey ID.
     * @param siteId Site ID. If not defined, current site.
     */
    async invalidateQuestions(surveyId: number, siteId?: string): Promise<void> {
        const site = await CoreSites.getSite(siteId);

        await site.invalidateWsCacheForKey(this.getQuestionsCacheKey(surveyId));
    }

    /**
     * Invalidates survey data.
     *
     * @param courseId Course ID.
     * @param siteId Site ID. If not defined, current site.
     */
    async invalidateSurveyData(courseId: number, siteId?: string): Promise<void> {
        const site = await CoreSites.getSite(siteId);

        await site.invalidateWsCacheForKey(this.getSurveyCacheKey(courseId));
    }

    /**
     * Report the survey as being viewed.
     *
     * @param id Module ID.
     * @param siteId Site ID. If not defined, current site.
     * @returns Promise resolved when the WS call is successful.
     */
    async logView(id: number, siteId?: string): Promise<void> {
        const params: AddonModSurveyViewSurveyWSParams = {
            surveyid: id,
        };

        await CoreCourseLogHelper.log(
            'mod_survey_view_survey',
            params,
            ADDON_MOD_SURVEY_COMPONENT_LEGACY,
            id,
            siteId,
        );
    }

    /**
     * Send survey answers. If cannot send them to Moodle, they'll be stored in offline to be sent later.
     *
     * @param surveyId Survey ID.
     * @param name Survey name.
     * @param courseId Course ID the survey belongs to.
     * @param answers Answers.
     * @param siteId Site ID. If not defined, current site.
     * @returns Promise resolved with boolean if success: true if answers were sent to server,
     *         false if stored in device.
     */
    async submitAnswers(
        surveyId: number,
        name: string,
        courseId: number,
        answers: AddonModSurveySubmitAnswerData[],
        siteId?: string,
    ): Promise<boolean> {

        // Convenience function to store a survey to be synchronized later.
        const storeOffline = async (): Promise<boolean> => {
            await AddonModSurveyOffline.saveAnswers(surveyId, name, courseId, answers, siteId);

            return false;
        };

        siteId = siteId || CoreSites.getCurrentSiteId();

        if (!CoreNetwork.isOnline()) {
            // App is offline, store the message.
            return storeOffline();
        }

        try {
            // If there's already answers to be sent to the server, discard it first.
            await AddonModSurveyOffline.deleteSurveyAnswers(surveyId, siteId);

            // Device is online, try to send them to server.
            await this.submitAnswersOnline(surveyId, answers, siteId);

            return true;
        } catch (error) {
            if (CoreWSError.isWebServiceError(error)) {
                // It's a WebService error, the user cannot send the message so don't store it.
                throw error;
            }

            return storeOffline();
        }
    }

    /**
     * Send survey answers to Moodle.
     *
     * @param surveyId Survey ID.
     * @param answers Answers.
     * @param siteId Site ID. If not defined, current site.
     * @returns Promise resolved when answers are successfully submitted.
     */
    async submitAnswersOnline(surveyId: number, answers: AddonModSurveySubmitAnswerData[], siteId?: string): Promise<void> {
        const site = await CoreSites.getSite(siteId);

        const params: AddonModSurveySubmitAnswersWSParams = {
            surveyid: surveyId,
            answers: answers,
        };

        const response = await site.write<CoreStatusWithWarningsWSResponse>('mod_survey_submit_answers', params);
        if (!response.status) {
            throw new CoreError('Error submitting answers.');
        }
    }

}
export const AddonModSurvey = makeSingleton(AddonModSurveyProvider);

/**
 * Params of mod_survey_view_survey WS.
 */
type AddonModSurveyViewSurveyWSParams = {
    surveyid: number; // Survey instance id.
};

/**
 * Survey returned by WS mod_survey_get_surveys_by_courses.
 */
export type AddonModSurveySurvey = CoreCourseModuleStandardElements & {
    template?: number; // Survey type.
    days?: number; // Days.
    questions?: string; // Question ids.
    surveydone?: number; // Did I finish the survey?.
    timecreated?: number; // Time of creation.
    timemodified?: number; // Time of last modification.
};

/**
 * Survey question.
 */
export type AddonModSurveyQuestion = {
    id: number; // Question id.
    text: string; // Question text.
    shorttext: string; // Question short text.
    multi: string; // Subquestions ids.
    intro: string; // The question intro.
    type: number; // Question type.
    options: string; // Question options.
    parent: number; // Parent question (for subquestions).
};

/**
 * Params of mod_survey_get_questions WS.
 */
type AddonModSurveyGetQuestionsWSParams = {
    surveyid: number; // Survey instance id.
};

/**
 * Data returned by mod_survey_get_questions WS.
 */
export type AddonModSurveyGetQuestionsWSResponse = {
    questions: AddonModSurveyQuestion[];
    warnings?: CoreWSExternalWarning[];
};

/**
 * Params of mod_survey_get_surveys_by_courses WS.
 */
type AddonModSurveyGetSurveysByCoursesWSParams = {
    courseids?: number[]; // Array of course ids.
};

/**
 * Data returned by mod_survey_get_surveys_by_courses WS.
 */
export type AddonModSurveyGetSurveysByCoursesWSResponse = {
    surveys: AddonModSurveySurvey[];
    warnings?: CoreWSExternalWarning[];
};

export type AddonModSurveySubmitAnswerData = {
    key: string; // Answer key.
    value: string; // Answer value.
};

/**
 * Params of mod_survey_submit_answers WS.
 */
type AddonModSurveySubmitAnswersWSParams = {
    surveyid: number; // Survey id.
    answers: AddonModSurveySubmitAnswerData[];
};
