/*
 * Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package org.ballerinalang.langserver.commons.workspace;

import io.ballerina.projects.Project;

import java.util.Collections;
import java.util.Map;
import java.util.Optional;
import java.util.WeakHashMap;
import java.util.concurrent.locks.Lock;

/**
 * Records which lock guards a {@link Project} instance, so code outside the workspace manager can compile it under
 * the same lock the workspace manager uses.
 * <p>
 * Compiling a package is not thread-safe in the compiler: two first-time compilations of the same project add to
 * the project's compiler plugin contexts, an unsynchronized list, at the same time. The workspace manager
 * serializes its own compilations with its per-project lock, so any other code that compiles a project the
 * workspace manager holds has to take that lock too, not a lock of its own.
 * <p>
 * Keyed by instance, not by source root: a cloned workspace's duplicate of a project has the same source root but
 * its own compiler state and its own lock. The keys are weak, so a project the workspace manager has replaced is
 * dropped once nothing else holds it.
 */
public final class ProjectLocks {

    // Project does not override equals/hashCode, so this map is keyed by identity.
    private static final Map<Project, Lock> LOCKS = Collections.synchronizedMap(new WeakHashMap<>());

    private ProjectLocks() {
    }

    /**
     * Records the lock that guards the given project instance, replacing any earlier one.
     *
     * @param project the project instance
     * @param lock    the lock its owner takes before compiling or modifying it
     */
    public static void register(Project project, Lock lock) {
        LOCKS.put(project, lock);
    }

    /**
     * Returns the lock registered for the given project instance.
     *
     * @param project the project instance
     * @return the registered lock, or empty when no workspace manager holds this instance
     */
    public static Optional<Lock> of(Project project) {
        return Optional.ofNullable(LOCKS.get(project));
    }
}
